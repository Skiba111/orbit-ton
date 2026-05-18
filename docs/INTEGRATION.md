# ORBIT Integration Guide

Add ORBIT subscription billing to your application. This guide covers:
- Getting a Factory through the Registry (recommended)
- Sending a subscribe transaction from the user's wallet
- Receiving webhook events for confirmed charges
- Checking subscription status on-chain
- Securing your webhook endpoint

---

## Requirements

- Node.js 18+ on your backend
- A running relayer (configured per [DEPLOYMENT.md](DEPLOYMENT.md))
- A Factory contract (obtained via Registry — see step 0 below)

---

## 0. Get a Factory via Registry (recommended)

Instead of deploying a Factory manually, use the ORBIT Registry — it deploys a Factory for you with fee settings enforced at the contract level.

```bash
# Add to .env:
# REGISTRY_ADDRESS=EQAYj1s3g71yta1XaJUeCTEjMRtTBEzHL12-qBIQ4kSNSA_5   ← mainnet
# WALLET_MNEMONIC="word1 word2 ... word24"
# NETWORK=mainnet

ts-node scripts/register-service.ts
```

The script:
1. Sends `OP_REGISTRY_REGISTER` (0.3 TON) to the Registry
2. Registry deploys a Factory with your wallet as `service_addr`
3. Prints your Factory address — copy it into `.env` as `FACTORY_ADDRESS`

After that you can add plans to your Factory via `OP_ADD_PLAN`.

> **What is fixed:** `fee_bps` and `fee_collector` are set by ORBIT and baked into your Factory at deploy time. You cannot change them. You control only your own plans.

---

## 1. Subscribe message format

To create a subscription, the user's wallet sends a message to your Factory address.

### Message body layout

```
op           (32 bits) = 0x4F520001   — OP_SUBSCRIBE
query_id     (64 bits)               — arbitrary request ID (0 is valid)
plan_id      (32 bits)               — plan index (0, 1, 2, ...)
payment_type  (2 bits)               — 1 = TON,  2 = Jetton  (0 is INVALID)
```

> **Critical:** Factory always reads `query_id` (64 bits) after `op`. If `query_id` is omitted, the message bounces with an underflow error. `PAYMENT_TON = 1` (not 0).

### TypeScript example

```typescript
import { beginCell, toNano } from "@ton/core";

// TON subscription on plan 0
const body = beginCell()
    .storeUint(0x4F520001, 32)  // OP_SUBSCRIBE
    .storeUint(0,           64)  // query_id (0 is fine)
    .storeUint(0,           32)  // plan_id = 0
    .storeUint(1,            2)  // payment_type = PAYMENT_TON (must be 1, not 0)
    .endCell();

// value = plan_price + STORAGE_RESERVE(0.05 TON) + FACTORY_DEPLOY_GAS(0.05 TON) + buffer
// Minimum: plan_price + 0.1 TON
// Recommended: plan_price + 0.2 TON
const PLAN_PRICE = toNano("1"); // 1 TON/month plan
const value = PLAN_PRICE + toNano("0.2");
```

### Via TonConnect (frontend)

```typescript
import { useTonConnectUI } from "@tonconnect/ui-react";
import { beginCell, toNano } from "@ton/core";

function SubscribeButton({ planId, planPrice }: { planId: number; planPrice: bigint }) {
    const [tonConnectUI] = useTonConnectUI();

    async function handleSubscribe() {
        const body = beginCell()
            .storeUint(0x4F520001, 32)
            .storeUint(0,           64)
            .storeUint(planId,      32)
            .storeUint(1,            2)  // PAYMENT_TON = 1
            .endCell();

        await tonConnectUI.sendTransaction({
            validUntil: Math.floor(Date.now() / 1000) + 300,
            messages: [{
                address: FACTORY_ADDRESS,
                amount:  String(planPrice + toNano("0.2")),
                payload: body.toBoc().toString("base64"),
            }],
        });
    }

    return <button onClick={handleSubscribe}>Subscribe</button>;
}
```

### Jetton subscription

For Jetton payments (e.g. USDT), also include the subscriber's Jetton wallet address:

```typescript
const body = beginCell()
    .storeUint(0x4F520001, 32)
    .storeUint(0,           64)
    .storeUint(planId,      32)
    .storeUint(2,            2)   // PAYMENT_JETTON = 2
    .storeAddress(subscriberJettonWalletAddress)  // subscriber's Jetton wallet address
    .endCell();

// value — TON for gas only (Jetton tokens are sent separately via transfer_notification)
// Minimum: 0.2 TON; recommended: 0.3 TON
```

> **⚠️ Jetton fee limitation (current version):** For Jetton subscriptions the service fee (`fee_bps`) and protocol fee are computed against the Jetton token unit count, not the TON value. For example, on a 1 USDT plan (1 000 000 micro-USDT) with `fee_bps = 150`, the fee is `bps_of(1_000_000, 150) = 15 000` — which is then sent as 15 000 nanoton (~0.000015 TON), not 0.015 USDT. **In practice, fee collection for Jetton plans is near-zero.** ORBIT currently uses `PLATFORM_FEE_BPS = 0` for Jetton deployments and recommends TON-denominated plans for any deployment where fee economics matter. A dedicated Jetton fee model will be addressed in a future version.

---

## 2. Webhook — receiving charge events

After each confirmed charge, the relayer sends a POST to your `WEBHOOK_URL`:

```json
{
  "event":      "charge_confirmed",
  "address":    "EQD_your_subscription_contract_address_here",
  "seqno_from": 0,
  "seqno_to":   1,
  "timestamp":  1747374000
}
```

| Field | Description |
|---|---|
| `address` | Subscriber's Subscription contract address |
| `seqno_from` | Seqno before the charge |
| `seqno_to` | Seqno after (equals total number of successful charges) |
| `timestamp` | Unix timestamp of the event |

### Relayer configuration

```env
WEBHOOK_URL=https://api.yourapp.com/orbit/webhook
WEBHOOK_SECRET=long-random-string-at-least-32-chars
```

Generate a secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Webhook handler (Node.js)

```typescript
import * as http from "http";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";

const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/orbit/webhook") {
        res.writeHead(404); res.end(); return;
    }

    // 1. Verify the secret
    if (WEBHOOK_SECRET && req.headers["X-Orbit-Secret"] !== WEBHOOK_SECRET) {
        res.writeHead(401); res.end("Unauthorized"); return;
    }

    // 2. Read the body
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
        try {
            const event = JSON.parse(body);
            if (event.event === "charge_confirmed") {
                await onChargeConfirmed(event.address, event.seqno_to);
            }
            res.writeHead(200); res.end("OK");
        } catch {
            res.writeHead(400); res.end("Bad Request");
        }
    });
});

async function onChargeConfirmed(subscriptionAddress: string, seqno: number) {
    // Look up the user by subscriptionAddress and grant access in your system
    console.log(`Charge confirmed: ${subscriptionAddress}, seqno=${seqno}`);
    // Example:
    // const user = await db.users.findOne({ subscriptionAddress });
    // if (user) await grantAccess(user.id, billingPeriodDays);
}

server.listen(3001);
```

Full example with retry and deduplication: [`scripts/webhook-server.ts`](../scripts/webhook-server.ts)

### Optional: on-chain verification

For maximum security, verify seqno directly on-chain before granting access:

```typescript
import { TonClient, Address } from "@ton/ton";
import { Subscription }       from "../wrappers/Subscription";

const client = new TonClient({
    endpoint: "https://toncenter.com/api/v2/jsonRPC",
    apiKey:   process.env.TONCENTER_API_KEY,
});

async function onChargeConfirmed(address: string, seqnoTo: number) {
    // On-chain check — cannot be faked even if WEBHOOK_SECRET leaks
    const sub       = client.open(Subscription.createFromAddress(Address.parse(address)));
    const realSeqno = await sub.getSeqno();
    if (realSeqno < seqnoTo) {
        console.error("Suspicious payload — seqno mismatch");
        return;
    }
    // Grant access
}
```

---

## 3. Checking subscription status

```typescript
import { TonClient, Address } from "@ton/ton";
import { Subscription }       from "../wrappers/Subscription";

const client = new TonClient({
    endpoint: "https://toncenter.com/api/v2/jsonRPC",
    apiKey:   process.env.TONCENTER_API_KEY,
});

const sub = client.open(
    Subscription.createFromAddress(Address.parse("EQD...subscription_address..."))
);

// All getters are called with no arguments:
const status      = await sub.getStatus();           // number (see table below)
const seqno       = await sub.getSeqno();            // number of successful charges
const nextBilling = await sub.getNextBillingTime();  // unix timestamp
const deposit     = await sub.getDeposit();          // remaining deposit: nanoTON for TON plans, token units for Jetton plans
```

**Status codes:**

| Code | Constant | Meaning |
|---|---|---|
| 1 | `STATUS_TRIAL` | Free trial, no charge yet |
| 2 | `STATUS_ACTIVE` | Active, billing running |
| 3 | `STATUS_PAUSED` | Paused (by subscriber or service) |
| 4 | `STATUS_GRACE` | Insufficient funds, 3-day grace period |
| 5 | `STATUS_CANCELLED` | Cancelled, deposit returned |

---

## 4. Subscriber actions — cancel, pause, top-up

All three actions are sent by the subscriber's wallet directly to the **Subscription contract address** (not the Factory). Each requires ~0.05 TON for gas; the excess is returned.

### Cancel

Immediately cancels the subscription and refunds the remaining deposit to the subscriber.

```typescript
import { beginCell, toNano } from "@ton/core";
import { useTonConnectUI } from "@tonconnect/ui-react";

const OP_CANCEL = 0x4F520010;

function CancelButton({ subscriptionAddress }: { subscriptionAddress: string }) {
    const [tonConnectUI] = useTonConnectUI();

    async function handleCancel() {
        const body = beginCell()
            .storeUint(OP_CANCEL, 32)
            .storeUint(0, 64)   // query_id
            .endCell();

        await tonConnectUI.sendTransaction({
            validUntil: Math.floor(Date.now() / 1000) + 300,
            messages: [{
                address: subscriptionAddress,   // the Subscription contract, NOT the Factory
                amount:  String(toNano("0.05")),
                payload: body.toBoc().toString("base64"),
            }],
        });
    }

    return <button onClick={handleCancel}>Cancel subscription</button>;
}
```

After cancellation:
- `status` becomes `5` (`STATUS_CANCELLED`)
- The remaining deposit is returned to the subscriber's wallet automatically
- The subscription cannot be reactivated — the subscriber must create a new one via `OP_SUBSCRIBE`

> Both the subscriber and the service owner can cancel. The service cannot cancel while a Jetton transfer is in progress (`charging_in_progress = 1`).

### Pause

Pauses billing without cancelling. The subscription stays alive; charges are skipped while paused.

> **Note:** `OP_PAUSE_SUB` is only accepted in `STATUS_ACTIVE` or `STATUS_TRIAL`. A subscription in `STATUS_GRACE` cannot be paused — it must either be topped up (to resume normal billing) or cancelled.

```typescript
const OP_PAUSE_SUB = 0x4F520012;

const body = beginCell()
    .storeUint(OP_PAUSE_SUB, 32)
    .storeUint(0, 64)
    .endCell();
// send to subscriptionAddress with toNano("0.05")
```

Resume with `OP_RESUME_SUB = 0x4F520013` (same message format).

### Top-up deposit

Adds TON to the subscription deposit so billing can continue (e.g. after a `STATUS_GRACE` warning).

```typescript
const OP_TOP_UP   = 0x4F520011;
const topUpAmount = toNano("2");  // amount to add to deposit

const body = beginCell()
    .storeUint(OP_TOP_UP, 32)
    .storeUint(0, 64)
    .endCell();

await tonConnectUI.sendTransaction({
    validUntil: Math.floor(Date.now() / 1000) + 300,
    messages: [{
        address: subscriptionAddress,
        amount:  String(topUpAmount + toNano("0.05")),  // topUp amount + gas
        payload: body.toBoc().toString("base64"),
    }],
});
```

> **TON subscriptions only:** the contract also accepts a plain TON transfer (no body) as a deposit top-up. Using `OP_TOP_UP` with a `query_id` is recommended so you can track the transaction. For Jetton subscriptions, plain TON transfers are accepted for gas/rent but do **not** add to the tracked token deposit — top up by sending Jetton tokens via the standard Jetton transfer flow.

---

## 5. Pre-computing the subscription address

The Subscription contract address is deterministic — you can compute it before the user subscribes:

```typescript
import { Factory } from "../wrappers/Factory";
import { TonClient, Address } from "@ton/ton";

const PAYMENT_TON    = 1;
const PAYMENT_JETTON = 2;

const client  = new TonClient({ endpoint: "..." });
const factory = client.open(Factory.createFromAddress(Address.parse(FACTORY_ADDRESS)));

// For TON subscriptions (payment_type defaults to PAYMENT_TON = 1):
const subscriptionAddress = await factory.getSubscriptionAddress(
    subscriberAddress,  // Address object
    planId,             // number
    // paymentType defaults to PAYMENT_TON — omit for TON plans
);

// For Jetton subscriptions — payment_type is baked into the contract address:
const jettonSubscriptionAddress = await factory.getSubscriptionAddress(
    subscriberAddress,
    planId,
    PAYMENT_JETTON,
    subscriberJettonWalletAddress,  // required for Jetton — must match OP_SUBSCRIBE exactly
);

console.log("Subscription address:", subscriptionAddress.toString());
```

> **Important:** the subscription address is derived from `factory + subscriber + plan_id + payment_type + jetton_wallet`. Using the wrong `payment_type` or `jetton_wallet` produces a different address — you will not find the user's subscription. Always use the same parameters as the `OP_SUBSCRIBE` message.

Store this address in your database to link the user's wallet to their subscription.

---

## 6. Inspecting Factory plans

```typescript
import { Factory } from "../wrappers/Factory";
import { TonClient, Address } from "@ton/ton";

const factory = client.open(Factory.createFromAddress(Address.parse(FACTORY_ADDRESS)));

// Get plan count, then load each plan individually
const planCount = await factory.getPlanCount();

for (let planId = 0; planId < planCount; planId++) {
    const plan = await factory.getPlanData(planId);
    if (!plan.active) continue;
    console.log(`Plan ${planId}:`);
    console.log(`  Price:  ${plan.price / 1_000_000_000n} TON`);
    console.log(`  Period: ${plan.period / 86400} days`);
    console.log(`  Trial:  ${plan.trialPeriod > 0 ? plan.trialPeriod / 86400 + " days" : "none"}`);
}
```

---

## 7. React SDK (in development)

Source is in `sdk/react/`. Not yet published to npm. Watch releases.

Once published:
```bash
npm install @orbit-ton/react
```

Available components: `OrbitProvider`, `useSubscription`, `useSubscribe`, `useFactory`, `SubscribeButton`, `SubscriptionStatus`, `TopUpDeposit`, `KeeperPoolStatus`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Transaction bounces immediately | Wrong `payment_type` (0 is invalid) | Use `PAYMENT_TON = 1` |
| Transaction bounces immediately | Insufficient TON in value | `value >= plan_price + 0.1 TON` |
| Relayer does not see subscription | StateInit not detected | Update to current relayer version |
| Relayer shows 0 subscriptions | Wrong `FACTORY_ADDRESS` in `.env` | Check Factory address |
| Webhook not received | `WEBHOOK_URL` or `WEBHOOK_SECRET` mismatch | Must match exactly on server and relayer |
| `Error on ...: status 500` | Subscription deposit exhausted | Normal for test subscription; top up deposit |
| `getSeqno(provider)` — TypeScript error | Passing provider manually is not needed | When using `client.open(...)` the SDK injects the provider automatically. Call as `await sub.getSeqno()` with no arguments. |
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    
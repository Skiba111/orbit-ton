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
# REGISTRY_ADDRESS=EQD...  ← address of the deployed ORBIT Registry
# WALLET_MNEMONIC="word1 word2 ... word24"
# NETWORK=testnet

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

---

## 2. Webhook — receiving charge events

After each confirmed charge, the relayer sends a POST to your `WEBHOOK_URL`:

```json
{
  "event":      "charge_confirmed",
  "address":    "EQAem3BPC7PvJzPGItrwNDVizMSqFIZ0nUDZvebfB4NBDn5w",
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
    if (WEBHOOK_SECRET && req.headers["x-orbit-secret"] !== WEBHOOK_SECRET) {
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
const deposit     = await sub.getDeposit();          // remaining deposit in nanoTON
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

## 4. Pre-computing the subscription address

The Subscription contract address is deterministic — you can compute it before the user subscribes:

```typescript
import { Factory } from "../wrappers/Factory";
import { TonClient, Address } from "@ton/ton";

const client  = new TonClient({ endpoint: "..." });
const factory = client.open(Factory.createFromAddress(Address.parse(FACTORY_ADDRESS)));

// Address is determined by: factory + subscriber wallet + plan_id
const subscriptionAddress = await factory.getSubscriptionAddress(
    subscriberAddress,  // Address object
    planId,             // number
);

console.log("Subscription address:", subscriptionAddress.toString());
```

Store this address in your database to link the user's wallet to their subscription.

---

## 5. Inspecting Factory plans

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

## 6. React SDK (in development)

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
| `getSeqno(provider)` — error | Deprecated API | Call without arguments: `await sub.getSeqno()` |
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    
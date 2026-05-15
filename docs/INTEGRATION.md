# Integration Guide

Integrate ORBIT recurring payments into your dApp in 15 minutes.

## Prerequisites

- A deployed Factory contract (see [DEPLOYMENT.md](DEPLOYMENT.md))
- TonConnect integration in your app (`@tonconnect/ui-react`)
- Node 18+ and React 18+

## 1. Install

```bash
npm install @orbit-ton/react @ton/core @tonconnect/ui-react
```

## 2. Wrap your app

```tsx
import { TonConnectUIProvider } from "@tonconnect/ui-react";
import { OrbitProvider }        from "@orbit-ton/react";

const ORBIT_CONFIG = {
    factoryAddress: "EQD...",  // your deployed Factory address
    endpoint: "https://toncenter.com/api/v2/jsonRPC",
    apiKey:   process.env.TONCENTER_API_KEY,
};

export default function Root({ children }) {
    return (
        <TonConnectUIProvider manifestUrl="https://yourapp.com/tonconnect-manifest.json">
            <OrbitProvider config={ORBIT_CONFIG}>
                {children}
            </OrbitProvider>
        </TonConnectUIProvider>
    );
}
```

## 3. Show pricing plans

```tsx
import { useFactory, SubscribeButton } from "@orbit-ton/react";

export function PricingPage() {
    const { plans, loading, error } = useFactory();

    if (loading) return <p>Loading plans…</p>;
    if (error)   return <p>Error: {error}</p>;

    return (
        <div>
            {plans.filter(p => p.active).map(plan => (
                <PlanCard key={plan.planId} plan={plan} />
            ))}
        </div>
    );
}

function PlanCard({ plan }) {
    return (
        <div>
            <h3>{plan.price / 1_000_000_000n} TON / {plan.period / 86400} days</h3>
            <SubscribeButton
                plan={plan}
                depositPeriods={3}     // pre-fund 3 billing cycles
                onSuccess={() => alert("Subscribed!")}
            />
        </div>
    );
}
```

## 4. Display subscription status

```tsx
import { useSubscription, SubscriptionStatus as Codes } from "@orbit-ton/react";

const STATUS_LABEL: Record<number, string> = {
    [Codes.TRIAL]:     "Free trial",
    [Codes.ACTIVE]:    "Active",
    [Codes.PAUSED]:    "Paused",
    [Codes.GRACE]:     "Payment overdue",
    [Codes.CANCELLED]: "Cancelled",
};

export function SubscriptionBadge({ subscriptionAddress }: { subscriptionAddress: string }) {
    const { data, loading } = useSubscription(subscriptionAddress);

    if (loading || !data) return null;

    const label    = STATUS_LABEL[data.status] ?? "Unknown";
    const daysLeft = Math.floor((data.nextBillingTime - Date.now() / 1000) / 86400);

    return (
        <div>
            <span>{label}</span>
            {data.status === Codes.ACTIVE && <span> · renews in {daysLeft}d</span>}
            <span> · deposit: {data.deposit / 1_000_000_000n} TON</span>
        </div>
    );
}
```

## 5. Top up deposit

```tsx
import { TopUpDeposit } from "@orbit-ton/react";

// subscriptionAddress: the address of the user's Subscription contract
<TopUpDeposit subscriptionAddress={subAddr} />
```

## 5b. Understanding fees

Before sending payment to your service, every billing cycle deducts two fees:

```
Subscriber deposit
    └─ gross_amount (plan price)
           ├─ protocol fee (0.2%, fixed in bytecode) → ORBIT wallet
           ├─ service fee (configurable, e.g. 1%)    → your fee_collector
           └─ net_amount                             → your service address
```

**What your service receives** = `plan_price × (1 − service_fee_bps/10000 − 0.002)`

Example — 10 TON/month, service fee 2%:
- Protocol fee: 0.02 TON
- Service fee: 0.20 TON
- **Net to service**: 9.78 TON

**The subscriber deposits `plan_price` per cycle, not `net_amount`.**
When displaying plan prices to subscribers, show the full `plan_price` from the factory — that is what leaves their deposit. Your service should be aware that it receives slightly less.

**Important for Jetton plans**: the subscriber's deposit is in Jettons, but the gas for protocol fee and service fee routing is paid in TON. The TON attached to the subscribe message must cover:
- Subscription contract gas budget (≥ 0.2 TON recommended)
- Jetton transfer fees (≥ 0.05 TON per cycle × pre-funded periods)

If the TON part is too small, charges will fail even when the Jetton deposit is sufficient. Use `value ≥ 0.2 TON + 0.05 × depositPeriods` when subscribing to Jetton plans.

## 6. Jetton subscriptions

For Jetton (e.g. USDT) subscriptions, pass `paymentType` and the subscriber's Jetton wallet address:

```tsx
import { buildSubscribeCell, PAYMENT_JETTON } from "@orbit-ton/react";
import { useTonConnectUI }                     from "@tonconnect/ui-react";

function JettonSubscribeButton({ plan, jettonWallet }) {
    const [ui] = useTonConnectUI();

    async function subscribe() {
        const body = buildSubscribeCell(plan.planId, PAYMENT_JETTON, jettonWallet);
        await ui.sendTransaction({
            messages: [{
                address: FACTORY_ADDRESS,
                amount:  String(toNano("0.2")), // gas only; Jetton tokens sent separately
                payload: body.toBoc().toString("base64"),
            }],
        });
    }

    return <button onClick={subscribe}>Subscribe with USDT</button>;
}
```

## 7. Determine the subscription address

Before a subscriber has ever subscribed, you can pre-compute the address where their contract will be deployed:

```typescript
import { Factory } from "@orbit-ton/react";
import { TonClient, Address } from "@ton/core";

const client  = new TonClient({ endpoint: "..." });
const factory = client.open(Factory.createFromAddress(Address.parse(FACTORY_ADDRESS)));

const subAddr = await factory.getSubscriptionAddress(
    client.provider(Address.parse(FACTORY_ADDRESS)),
    subscriber.address,
    planId,
);
```

Use this address to gate access in your backend: poll its `get_status` getter or listen for `OP_CHARGE_INTERNAL` messages arriving at your service address.

## 8. Verifying access in your backend

### Via ORBIT relayer webhook (recommended)

Set `WEBHOOK_URL` on your relayer. After every confirmed charge, the relayer POSTs:

```json
{
  "event":      "charge_confirmed",
  "address":    "EQD...",
  "seqno_from": 4,
  "seqno_to":   5,
  "timestamp":  1718000000
}
```

`address` is the Subscription contract address. Map it to your user record and provision access.

#### Webhook authentication (required in production)

Without authentication anyone can POST a fake payload to your endpoint and get free access. Set a shared secret:

```bash
# .env on your server (both relayer and webhook-server must share this value)
WEBHOOK_SECRET=some-long-random-string-here
```

Generate a strong secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The ORBIT relayer sends `X-Orbit-Secret` header with every POST. Verify it in your handler:

```typescript
app.post('/orbit/webhook', (req, res) => {
    if (req.headers['x-orbit-secret'] !== process.env.WEBHOOK_SECRET) {
        return res.sendStatus(401);
    }
    // ... handle event
});
```

For maximum security, verify the `seqno_to` on-chain before granting access:

```typescript
import { TonClient, Address } from "@ton/core";
import { Subscription }       from "@orbit-ton/react";

app.post('/orbit/webhook', async (req, res) => {
    // 1. Check shared secret
    if (req.headers['x-orbit-secret'] !== process.env.WEBHOOK_SECRET) {
        return res.sendStatus(401);
    }

    const { address, seqno_to } = req.body;

    // 2. Verify seqno on-chain — cannot be faked even if secret is leaked
    const sub       = client.open(Subscription.createFromAddress(Address.parse(address)));
    const realSeqno = await sub.getSeqno(client.provider(Address.parse(address)));
    if (realSeqno < seqno_to) return res.sendStatus(400); // fake payload

    // 3. Grant access
    // ...
    res.sendStatus(200);
});
```

### Via on-chain message parsing (authoritative)

Your service receives `OP_CHARGE_INTERNAL` messages from the Subscription contract. The body contains:

```
op (32) | query_id (64) | subscriber_addr (267) | plan_id (32)
```

In Node.js (using `@ton/core`):

```typescript
import { Cell, Address } from "@ton/core";

function parseChargeInternal(bodyBoc: string) {
    const body = Cell.fromBoc(Buffer.from(bodyBoc, "base64"))[0].beginParse();
    const op           = body.loadUint(32);    // 0x4F520020
    const queryId      = body.loadUint(64);
    const subscriber   = body.loadAddress();   // Address
    const planId       = body.loadUint(32);
    return { op, queryId, subscriber, planId };
}
```

Only accept messages from addresses that are known subscriptions for your factory. Verify:

```typescript
import { Factory } from "@orbit-ton/react";
import { TonClient, Address } from "@ton/core";

async function isValidSubscription(
    client:        TonClient,
    factoryAddr:   string,
    subAddr:       string,
    subscriberAddr: Address,
    planId:        number,
): Promise<boolean> {
    const factory  = client.open(Factory.createFromAddress(Address.parse(factoryAddr)));
    const provider = client.provider(Address.parse(factoryAddr));
    const expected = await factory.getSubscriptionAddress(provider, subscriberAddr, planId);
    return expected.toString() === subAddr;
}
```

### Via TonCenter event webhook (alternative)

TonCenter supports account-level webhooks. Subscribe to events on your service address and filter for `OP_CHARGE_INTERNAL = 0x4F520020` in the incoming message op.

## 9. TonConnect manifest

TonConnect requires a manifest file hosted at a public URL. Create `public/tonconnect-manifest.json`:

```json
{
  "url":      "https://yourapp.com",
  "name":     "Your App Name",
  "iconUrl":  "https://yourapp.com/icon-192.png",
  "termsOfUseUrl": "https://yourapp.com/terms",
  "privacyPolicyUrl": "https://yourapp.com/privacy"
}
```

Pass the URL when initialising TonConnect:

```tsx
<TonConnectUIProvider manifestUrl="https://yourapp.com/tonconnect-manifest.json">
    <App />
</TonConnectUIProvider>
```

The `iconUrl` must be a square PNG, at least 192×192 px, served over HTTPS.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Transaction rejected immediately | `payment_type` missing in body | Use `buildSubscribeCell` from SDK — never build body manually |
| Subscription stuck in GRACE | Deposit too low after plan change | Call `TopUpDeposit` component or direct top-up |
| Keeper not triggering charges | Relayer not running or wrong pubkey | Check `RELAYER_MNEMONIC` matches `relayer_pubkey` in factory config |
| `ERROR_INSUFFICIENT_FUNDS` on subscribe | Sending too little TON | Value must cover `price × depositPeriods + 0.2 TON` for gas |

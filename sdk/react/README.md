# @orbit-ton/react

React SDK for integrating **ORBIT recurring payments** on TON blockchain into your app.

[![npm](https://img.shields.io/npm/v/@orbit-ton/react)](https://www.npmjs.com/package/@orbit-ton/react)
[![license](https://img.shields.io/github/license/Skiba111/orbit-ton)](LICENSE)

---

## Installation

```bash
npm install @orbit-ton/react @ton/core @ton/ton @tonconnect/ui-react
```

---

## Quick Start

Wrap your app in `<OrbitProvider>` once, then use any hook anywhere:

```tsx
import { OrbitProvider, SubscribeButton } from "@orbit-ton/react";
import { TonConnectUIProvider }           from "@tonconnect/ui-react";

function App() {
  return (
    <TonConnectUIProvider manifestUrl="https://yourapp.com/tonconnect-manifest.json">
      <OrbitProvider config={{
        factoryAddress: "EQA...", // your deployed Factory contract
        endpoint:       "https://toncenter.com/api/v2/jsonRPC",
        apiKey:         "your_toncenter_key",  // optional
      }}>
        <YourApp />
      </OrbitProvider>
    </TonConnectUIProvider>
  );
}
```

---

## Hooks

### `useSubscribe()`

Subscribe to a plan via TonConnect.

```tsx
const { subscribe, loading, error } = useSubscribe();

// TON subscription — pre-fund 3 periods
await subscribe(
  planId,                          // number
  planPrice * 3n,                  // deposit in nanoton
);

// Jetton subscription
await subscribe(planId, 0n, PAYMENT_JETTON, jettonWalletAddress);
```

### `useSubscription(address, refreshInterval?)`

Read on-chain subscription state (auto-refreshes every 15 s by default).

```tsx
const { data, loading, error, refetch } = useSubscription(subscriptionAddress);

if (data) {
  console.log(data.status);          // 1=TRIAL 2=ACTIVE 3=PAUSED 4=GRACE 5=CANCELLED
  console.log(data.deposit);         // nanoton
  console.log(data.nextBillingTime); // unix timestamp
}
```

### `useFactory()`

Read all plans and factory stats.

```tsx
const { plans, totalRevenue, totalCharges, keeperPool, loading } = useFactory();
```

### `useCancel()`

Cancel a subscription (subscriber-initiated). Returns remaining deposit.

```tsx
const { cancel, loading, error } = useCancel();

await cancel(subscriptionAddress);
```

### `useTopUp()`

Top up a subscription deposit.

```tsx
const { topUp, loading, error } = useTopUp();

// Add 2 TON to deposit
await topUp(subscriptionAddress, toNano("2"));
```

### `usePause()` / `useResume()`

Pause and resume auto-charges (deposit stays locked).

```tsx
const { pause }  = usePause();
const { resume } = useResume();

await pause(subscriptionAddress);
await resume(subscriptionAddress);
```

### `useChangePlan()`

Switch to a different plan (sends through Factory, no subscription address needed).

```tsx
const { changePlan, loading } = useChangePlan();

await changePlan(newPlanId);
```

---

## Components

All components are unstyled by default — pass a `className` prop to style them.

### `<SubscribeButton>`

```tsx
<SubscribeButton
  plan={planData}              // PlanData from useFactory()
  depositPeriods={3}           // pre-fund 3 billing cycles (default: 1)
  paymentType={PAYMENT_TON}    // or PAYMENT_JETTON
  onSuccess={() => router.push("/success")}
  onError={(err) => console.error(err)}
/>
```

### `<SubscriptionStatus>`

Shows status badge, next billing countdown, deposit balance, and a Cancel button.

```tsx
<SubscriptionStatus subscriptionAddress={address} />
```

### `<TopUpDeposit>`

Amount input + Top Up button.

```tsx
<TopUpDeposit
  subscriptionAddress={address}
  onSuccess={() => toast("Deposit topped up!")}
/>
```

### `<KeeperPoolStatus>`

Displays the factory's keeper pool balance.

```tsx
<KeeperPoolStatus />
```

---

## Operator REST API Client

For server-side integrations (Node.js, edge functions) — authenticate with an `orbit_sk_*` key:

```ts
import { OrbitApiClient, verifyWebhookSignature } from "@orbit-ton/react";

const orbit = new OrbitApiClient({
  baseUrl: "https://api.yourapp.com/api/v1",
  apiKey:  "orbit_sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
});

// List services
const services = await orbit.services.list();

// Analytics overview (last 30 days)
const stats = await orbit.analytics.overview(serviceId, { days: 30 });
console.log(stats.mrr.mrrTon, stats.churn?.churnRate);

// Active subscriptions
const subs = await orbit.subscriptions.list(serviceId, { status: "ACTIVE" });

// Register a webhook endpoint
const webhook = await orbit.webhooks.create(serviceId, {
  url:    "https://yourapp.com/webhooks/orbit",
  events: ["charge.success", "subscription.activated"],
});
console.log(webhook.secret); // save this! shown only once

// Create an API key
const key = await orbit.apiKeys.create({ name: "production" });
console.log(key.key); // save this! shown only once
```

### Verify incoming webhooks

```ts
// Express / Next.js webhook handler
app.post("/webhooks/orbit", express.raw({ type: "application/json" }), async (req, res) => {
  const isValid = await verifyWebhookSignature(
    req.body.toString(),             // raw body string (before JSON.parse)
    req.headers["x-orbit-signature"] as string,
    process.env.ORBIT_WEBHOOK_SECRET!,
  );

  if (!isValid) return res.status(401).send("Invalid signature");

  const event = JSON.parse(req.body.toString());
  if (event.event === "charge.success") {
    // grant access, send email, etc.
  }

  res.sendStatus(200);
});
```

### Supported webhook events

| Event | When |
|---|---|
| `charge.success` | Successful charge |
| `charge.failed` | Charge attempt failed |
| `subscription.activated` | New subscriber |
| `subscription.cancelled` | Subscriber cancelled |
| `subscription.grace` | Deposit too low, grace period started |
| `subscription.recovered` | Grace period ended, subscription restored after top-up |

---

## Subscription status codes

```ts
import { SubscriptionStatusCodes } from "@orbit-ton/react";

SubscriptionStatusCodes.TRIAL     // 1
SubscriptionStatusCodes.ACTIVE    // 2
SubscriptionStatusCodes.PAUSED    // 3
SubscriptionStatusCodes.GRACE     // 4
SubscriptionStatusCodes.CANCELLED // 5
```

---

## Types

```ts
import type {
  OrbitConfig,
  SubscriptionData,
  PlanData,
  StatusCode,
  // API client types:
  ServiceRecord,
  PlanRecord,
  SubscriptionRecord,
  ChargeRecord,
  AnalyticsOverview,
  WebhookEndpoint,
  ApiKeyRecord,
} from "@orbit-ton/react";
```

---

## Payment types

```ts
import { PAYMENT_TON, PAYMENT_JETTON } from "@orbit-ton/react";
// PAYMENT_TON    = 1
// PAYMENT_JETTON = 2
```

---

## Links

- [Contracts & protocol docs](../../docs/)
- [GitHub](https://github.com/Skiba111/orbit-ton)
- [Support](https://t.me/skiba111)

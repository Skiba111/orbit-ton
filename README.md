# ORBIT — Recurring Payments on TON

ORBIT is a modular smart-contract library for subscription billing on the TON blockchain. It lets any service accept recurring payments in TON or Jetton tokens without building billing infrastructure from scratch.

```
Subscriber ──► Factory ──► Subscription ──► Service
                                │
                                └──► FeeCollector (protocol fee)
```

## Features

- **TON & Jetton billing** — native coin or any TEP-74 token
- **On-chain deposit model** — subscribers pre-fund; no pull payments
- **Keeper network** — anyone can trigger charges and earn a reward
- **Grace period + retry** — 3-day window before cancellation on insufficient funds
- **Fixed-term subscriptions** — optional `max_periods` cap with auto-cancel
- **Plan change** — subscriber requests upgrade/downgrade; factory routes securely
- **Timelock withdrawals** — 24-hour delay on protocol fee withdrawals
- **Fully auditable** — all money flows are deterministic and verifiable on-chain

## Architecture

| Contract | Purpose |
|---|---|
| `Factory` | Deploys Subscription contracts; holds plan registry; routes plan changes |
| `Subscription` | Per-user billing state; holds subscriber deposit |
| `FeeCollector` | Accumulates protocol fees; two-phase timelock withdrawal |

## Quick Start

### React SDK

```bash
npm install @orbit-ton/react @ton/core @tonconnect/ui-react
```

```tsx
import { OrbitProvider, SubscribeButton, useFactory } from "@orbit-ton/react";

function App() {
    return (
        <OrbitProvider config={{ factoryAddress: "EQD...", endpoint: "https://toncenter.com/api/v2/jsonRPC" }}>
            <Pricing />
        </OrbitProvider>
    );
}

function Pricing() {
    const { plans } = useFactory();
    return plans.map(plan => (
        <SubscribeButton key={plan.planId} plan={plan} depositPeriods={3} />
    ));
}
```

### Read subscription state

```tsx
import { useSubscription, SubscriptionStatus } from "@orbit-ton/react";

function StatusBadge({ address }: { address: string }) {
    const { data } = useSubscription(address);
    if (!data) return null;
    const label = {
        [SubscriptionStatus.ACTIVE]:    "Active",
        [SubscriptionStatus.GRACE]:     "Grace period",
        [SubscriptionStatus.CANCELLED]: "Cancelled",
    }[data.status] ?? "Unknown";
    return <span>{label}</span>;
}
```

## Repository Layout

```
contracts/         Subscription and Factory Tolk contracts
billing/           Charge engine, fee router, retry scheduler
payment/           TON and Jetton payment adapters
plans/             Plan registry and trial logic
core/              Storage layout, period math, subscription state
access/            Role manager, emergency pause
utils/             Errors, ops codes, math, time oracle
wrappers/          TypeScript wrappers for Blueprint/sandbox tests
tests/             Security and integration test suites
scripts/           Deploy script and charge relayer
sdk/react/         @orbit-ton/react npm package
docs/              Developer documentation
```

## Testing

```bash
npm install
npm test
```

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Integration

See [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Security

See [docs/SECURITY.md](docs/SECURITY.md).

## License

MIT

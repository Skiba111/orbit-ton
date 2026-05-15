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

## Fee structure

Every billing cycle deducts two fees from the gross amount before sending payment to the service:

| Fee | Who sets it | Where it goes | Typical value |
|-----|------------|---------------|---------------|
| **Service fee** | Factory operator (`fee_bps`) | `fee_collector` of the factory | 0 – 10% |
| **Protocol fee** | Hardcoded in bytecode (`PROTOCOL_FEE_BPS = 20`) | ORBIT `protocol_fee_collector` | 0.2% (fixed) |

**Example** — 1 TON/month plan, service fee = 1% (100 bps):
- Gross: 1.000 TON
- Protocol fee (0.2%): 0.002 TON → ORBIT wallet
- Service fee (1%): 0.010 TON → service fee_collector
- **Net to service**: 0.988 TON

The protocol fee is baked into the Subscription contract bytecode. A service cannot change or bypass it without recompiling from source — which produces different bytecode that is verifiably not official ORBIT.

See [docs/PROTOCOL_FEE.md](docs/PROTOCOL_FEE.md) for details.

## Keeper network

Keepers are external actors who trigger charge cycles and earn a small reward per charge. No permission is needed — anyone can run a keeper.

- **Base reward**: 0.01 TON per charge (from subscription deposit)
- **Bonus reward**: up to 0.01 TON (from factory keeper pool, when funded)
- **Gas cost**: ~0.005 TON per charge

See [docs/KEEPER.md](docs/KEEPER.md) to get started.

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

## Verifying official ORBIT bytecode

Every official ORBIT Subscription has a published code hash. Anyone can verify a deployed contract is unmodified:

```bash
# Print the hash of your locally compiled contract
node scripts/verify-bytecode.js

# Verify a deployed contract against local build
node scripts/verify-bytecode.js EQD...subscriptionAddress...
```

Output:
```
✅  MATCH — this is official ORBIT bytecode.
    Protocol fee (0.2%) is active and routes to the published collector.
```

**Official mainnet bytecode hash:** `(published after mainnet deploy — see Releases)`

See [docs/PROTOCOL_FEE.md](docs/PROTOCOL_FEE.md).

## Keeper network

See [docs/KEEPER.md](docs/KEEPER.md).

## License

Business Source License 1.1 — free for non-commercial use.
Converts to MIT on 2029-05-15.
Commercial licensing: skibatima9@gmail.com

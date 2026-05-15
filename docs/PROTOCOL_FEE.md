# ORBIT Protocol Fee

## What it is

ORBIT charges a **0.2% protocol fee** on every billing cycle processed through an official ORBIT Subscription contract. This fee funds ORBIT protocol development and infrastructure.

| Constant | Value | Location |
|----------|-------|----------|
| `PROTOCOL_FEE_BPS` | `20` (0.2%) | `utils/protocol-config.tolk` — compiled into bytecode |
| `PROTOCOL_FEE_COLLECTOR_HASH` | 256-bit hash of ORBIT wallet | `utils/protocol-config.tolk` — compiled into bytecode |

## Why it is hardcoded in bytecode

The fee constants are compiled into the Subscription contract binary, not stored in contract storage. This means:

- **No service operator can change or bypass the fee.** No `save_storage`, no admin message, no factory configuration can alter what is baked into bytecode.
- **Verifiability.** Anyone can compare the deployed contract's code hash against the published ORBIT bytecode hash. A different hash means different bytecode — and possibly no protocol fee (i.e., not official ORBIT).
- **Immutability per subscription.** Once a Subscription is deployed, its fee rate and collector address are fixed for the lifetime of that contract.

## How the fee flows

```
Billing cycle fires
    │
    ├─ gross_amount deducted from subscriber deposit
    │
    ├─ protocol_fee = gross_amount × PROTOCOL_FEE_BPS / 10000
    │       └─ sent to protocol_fee_collector (bounceable)
    │              └─ if bounced → restored to subscriber deposit
    │
    ├─ service_fee = gross_amount × fee_bps / 10000
    │       └─ sent to factory fee_collector (bounceable)
    │
    └─ net_amount = gross_amount − protocol_fee − service_fee
            └─ sent to service address
```

All three sends are bounceable. If any bounces, the deposit is restored and the billing time rolls back — the subscriber is never silently drained.

## Verifying official ORBIT bytecode

To verify that a deployed Subscription is using unmodified ORBIT bytecode:

```bash
# 1. Get the code hash of any deployed Subscription contract
# (via TonCenter, tonscan.org, or any TON indexer)

# 2. Build the official ORBIT Subscription from source
npm run build

# 3. Print its code hash
node -e "
const { Cell } = require('@ton/core');
const { compileTolk } = require('./tests/helpers/compileTolk');
compileTolk('subscription').then(code => {
    console.log('Official code hash:', code.hash().toString('hex'));
});
"

# 4. Compare the two hashes
```

A match confirms the deployed contract uses the official ORBIT bytecode — with 0.2% protocol fee intact and routing to the published ORBIT wallet.

## Rotating the protocol fee collector

The ORBIT team may need to redirect fees to a new wallet (key rotation, multisig upgrade, etc.). This is done per-factory via `OP_UPDATE_PROTOCOL_COLLECTOR`:

- **Who can call it**: only the current `protocol_fee_collector` address (not the service owner)
- **Effect**: updates the `protocol_fee_collector` field in that factory's storage
- **Scope**: affects only new subscriptions deployed through that factory after the update; existing subscriptions use the address that was set at their deploy time

```typescript
// Factory wrapper — called by the ORBIT team from their wallet
await factory.sendUpdateProtocolCollector(orbitWallet.getSender(), newCollectorAddress);
```

New subscriptions subsequently deployed through this factory will have `protocol_fee_collector = newCollectorAddress` in their state. Existing subscriptions are unaffected.

## For service operators

You do not control the protocol fee. When deploying a Factory, you pass the ORBIT-published `protocolFeeCollector` address. This address is baked into every Subscription your Factory deploys.

When setting plan prices, account for the 0.2% protocol fee:

```
minimum_plan_price = desired_net_revenue / (1 − service_fee_rate − 0.002)
```

Example — you want to net 9.80 TON/month with a 1% service fee:
```
minimum_plan_price = 9.80 / (1 − 0.01 − 0.002) = 9.80 / 0.988 ≈ 9.919 TON
```

## For subscribers

The plan price shown in the UI is the gross amount deducted from your deposit per cycle. The service receives slightly less after fees. You can always verify the fee split by reading the subscription's `feeBps` getter (service fee) — the 0.2% protocol fee is always present regardless of what `feeBps` says.

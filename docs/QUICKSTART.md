# ORBIT Quick Start — First subscription in 10 minutes

This guide takes you from zero to a working recurring subscription on TON testnet.

---

## Prerequisites

- Node.js 18+
- A TON wallet with some testnet TON ([faucet](https://t.me/testgiver_ton_bot))
- `.env` file configured (copy `.env.example`, fill in `WALLET_MNEMONIC`)

```bash
git clone https://github.com/Skiba111/orbit-ton
cd orbit-ton
npm install
cp .env.example .env        # fill in WALLET_MNEMONIC, set NETWORK=testnet
```

---

## Step 1 — Register your service (1 transaction)

```bash
# Set the mainnet Registry address in your .env:
# REGISTRY_ADDRESS=EQAYj1s3g71yta1XaJUeCTEjMRtTBEzHL12-qBIQ4kSNSA_5

npx ts-node scripts/register-service.ts
```

You'll see:
```
✅ Registered! Your Factory: EQAbc...xyz
```

This deploys a Factory contract owned by your wallet with ORBIT's 1.5% protocol fee baked into the Subscription bytecode.

---

## Step 2 — Add a subscription plan

```ts
import { Factory } from "./wrappers/Factory";
import { toNano } from "@ton/core";

const factory = client.open(Factory.createFromAddress(Address.parse("EQAbc...xyz")));

await factory.sendAddPlan(wallet.getSender(), {
    price:       toNano("1"),   // 1 TON per period
    period:      2592000,       // 30 days in seconds
    trialPeriod: 0,             // no trial
    nameHash:    0n,
});
```

---

## Step 3 — Subscriber signs up

Your mini-app frontend (using `@orbit-ton/react` or direct wrapper):

```ts
const factory = client.open(Factory.createFromAddress(factoryAddr));

// Let the subscriber choose plan 0
await factory.sendSubscribe(subscriber.getSender(), 0, toNano("3")); // 3 TON deposit
```

A `Subscription` contract is deployed at a deterministic address for this subscriber.

---

## Step 4 — Relayer charges on schedule

The ORBIT relayer monitors subscriptions and sends `OP_CHARGE_EXT` when `next_billing_time` is due.

Start the relayer on your server:

```bash
# On the server (after setting FACTORY_ADDRESS and RELAYER_MNEMONIC in .env):
ts-node scripts/relayer.ts
# → [relayer] Scanning N subscriptions…
# → [relayer] Charged EQD... (seqno 0 → 1)
```

The relayer handles key signing, WAL crash recovery, and webhook delivery automatically. There is no manual charge API — use the relayer script.

---

## Mainnet addresses

| Contract | Address |
|----------|---------|
| Registry | `EQAYj1s3g71yta1XaJUeCTEjMRtTBEzHL12-qBIQ4kSNSA_5` |
| FeeCollector | `EQDXmTHoJvjahldT3_tpeGcZ0juiADEfhTBiKcQuFPnjz6S0` |

> Testnet: deploy your own Registry + FeeCollector via `deploy-registry.ts`.

---

## Full deploy (for ORBIT operators)

To deploy your own Registry + FeeCollector:

```bash
npx ts-node scripts/deploy-registry.ts
```

Required env vars:
- `WALLET_MNEMONIC` — 24-word seed phrase of the deployer wallet
- `FEE_COLLECTOR_PUBKEY` — hex Ed25519 pubkey of the cold fee-collector key
- `RELAYER_PUBKEY` — hex Ed25519 pubkey of the relayer key
- `NETWORK` — `testnet` or `mainnet`
- `WALLET_VERSION` — `v4` or `v5` (default: `v5`)

---

## Security checklist before mainnet (for ORBIT operators deploying their own Registry)

- [ ] Pass the correct `FeeCollector` address to `deploy-registry.ts` — this is the `protocolFeeCollector` that gets baked into every Factory and Subscription at deploy time
- [ ] Use a multisig wallet as `owner_addr` for Registry
- [ ] Verify deployed bytecode hashes match `docs/BYTECODE_HASHES.md` — run `ts-node scripts/_compute-hashes.ts`
- [ ] Run testnet E2E for at least 48 hours with the real relayer before switching to mainnet

> **Note:** `PROTOCOL_FEE_COLLECTOR_HASH` in `utils/protocol-config.tolk` is a reference-only constant — it is not called at runtime and does not need to be edited. The actual fee routing uses the address you pass to the deploy script.

---

## Architecture in 30 seconds

```
Registry (one per platform)
  └── Factory (one per service / mini-app)
        └── Subscription (one per subscriber × plan)
```

**Registry** → deploys Factories with enforced ORBIT fee settings  
**Factory** → holds plan catalog, deploys per-user Subscription contracts  
**Subscription** → holds subscriber deposit, executes billing on relayer signal

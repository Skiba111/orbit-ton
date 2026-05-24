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

## Verifying bytecode hashes

Before running on mainnet, confirm that your deployed contracts match the published hashes:

```bash
npx ts-node scripts/_compute-hashes.ts
```

Compare the output to [docs/BYTECODE_HASHES.md](BYTECODE_HASHES.md). Any mismatch means a non-official binary is deployed.

---

> **Deploying a Registry?** The Registry and FeeCollector are ORBIT platform infrastructure — they are deployed once by the ORBIT team and shared across all service operators. Service operators do not deploy a Registry. If you are evaluating ORBIT on a private testnet and need your own Registry, see `scripts/deploy-registry.ts` and the full checklist in [docs/DEPLOYMENT.md](DEPLOYMENT.md).

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

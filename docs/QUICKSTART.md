# ORBIT Quick Start — First subscription in 10 minutes

This guide takes you from zero to a working recurring subscription on TON testnet.

---

## Prerequisites

- Node.js 18+
- A TON wallet with some testnet TON ([faucet](https://t.me/testgiver_ton_bot))
- `.env` file configured (copy `.env.example`, fill in `MNEMONIC`)

```bash
git clone https://github.com/your-org/orbit-ton
cd orbit-ton
npm install
cp .env.example .env        # fill in MNEMONIC, set NETWORK=testnet
```

---

## Step 1 — Register your service (1 transaction)

```bash
# Set the Registry address (testnet) in your .env:
# REGISTRY_ADDRESS=EQ...

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

For local testing, trigger a charge manually:

```ts
import { Subscription } from "./wrappers/Subscription";

const sub = client.open(Subscription.createFromAddress(subAddr));

// Relayer signs and sends the charge external message
await sub.sendCharge(relayerKeypair, seqno, timestamp);
```

---

## Testnet addresses

| Contract | Address |
|----------|---------|
| Registry | `EQ...` *(update after deploy)* |
| FeeCollector | `EQ...` *(update after deploy)* |

---

## Full deploy (for ORBIT operators)

To deploy your own Registry + FeeCollector:

```bash
npx ts-node scripts/deploy-registry.ts
```

Required env vars:
- `MNEMONIC` — your deployer wallet seed
- `RELAYER_PUBKEY` — hex Ed25519 public key of your relayer
- `NETWORK` — `testnet` or `mainnet`

---

## Security checklist before mainnet

- [ ] Replace `PROTOCOL_FEE_COLLECTOR_HASH` in `utils/protocol-config.tolk` with your mainnet cold wallet hash
- [ ] Use a multisig wallet as `owner_addr` for Registry
- [ ] Verify bytecode hashes match `docs/BYTECODE_HASHES.md`
- [ ] Run testnet E2E for at least 48 hours with the real relayer

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

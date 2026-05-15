# Deployment Guide

> **Two separate deployments exist.** The ORBIT team deploys the FeeCollector once (protocol wallet). Service operators deploy a Factory per service. Read the steps below to understand which apply to you.

## Prerequisites

- Node 18+ with `ts-node` or `npx blueprint`
- A TON wallet with at least 2 TON for deployment gas
- An Ed25519 key pair for:
  - **Relayer key** — signs charge external messages (kept hot on relayer server)
  - **Fee-collector key** — signs withdrawal external messages (kept cold / hardware)

## Generate keys

```bash
# Install @ton/crypto if not already present
npm install @ton/crypto

# Generate relayer key
node -e "
const { mnemonicNew, mnemonicToPrivateKey } = require('@ton/crypto');
mnemonicNew(24).then(async m => {
    console.log('Mnemonic:', m.join(' '));
    const kp = await mnemonicToPrivateKey(m);
    console.log('Pubkey (hex):', Buffer.from(kp.publicKey).toString('hex'));
});
"

# Repeat for fee-collector key — store the mnemonic in cold storage
```

## Environment variables

```bash
# .env (never commit this file)
MNEMONICS="word1 word2 ... word24"           # wallet that pays deployment gas
FEE_COLLECTOR_PUBKEY="abcd1234..."           # hex Ed25519 pubkey (fee-collector key)
TONCENTER_API_KEY="your_key_here"            # optional, increases rate limits
```

## Step 0 — Set protocol fee collector (ORBIT team only, before mainnet build)

> **Skip this step if you are a service operator.** You deploy a Factory, not the protocol infrastructure. The `protocol_fee_collector` you pass to Factory comes from the ORBIT team — see their published addresses.

Before building Subscription bytecode for mainnet, set the protocol fee collector hash in `utils/protocol-config.tolk`:

```bash
# Get the 256-bit account_id of your TON wallet:
node -e "
const { Address } = require('@ton/core');
const addr = Address.parse('YOUR_ORBIT_WALLET_ADDRESS');
console.log('0x' + Buffer.from(addr.hash).toString('hex'));
"
```

Replace the placeholder in `utils/protocol-config.tolk`:
```tolk
// Before:
const PROTOCOL_FEE_COLLECTOR_HASH: int = 0;  // ← placeholder, fees go to zero address

// After:
const PROTOCOL_FEE_COLLECTOR_HASH: int = 0xYOUR_HASH_HERE;
```

Then rebuild:
```bash
npm run build
```

> **Warning:** Deploying with `PROTOCOL_FEE_COLLECTOR_HASH = 0` means every 0.2% protocol fee is sent to the zero address and is permanently lost. This is a one-time configuration — existing subscriptions cannot be migrated to a new collector without an explicit `OP_UPDATE_PROTOCOL_COLLECTOR` on each factory they were deployed through.

---

## Step 1a — Deploy FeeCollector (ORBIT team only)

The FeeCollector is protocol infrastructure owned by the ORBIT team. Service operators do not deploy it — they receive its address from the ORBIT team and pass it as `protocolFeeCollector` when deploying their Factory.

```bash
npx blueprint run deploy --target fee-collector
```

Save the printed FeeCollector address. Fund it with at least 0.1 TON for rent.

---

## Step 1b — Deploy Factory (service operators)

```bash
npx blueprint run deploy --target factory
```

Follow the prompts:
1. Enter your relayer pubkey (hex)
2. Enter your service owner address
3. Enter your service fee basis points (e.g. `100` = 1%)
4. Enter the ORBIT `protocolFeeCollector` address (published by ORBIT team)

The script deploys Factory and saves the address. Save it — you will need it for the React SDK and relayer config.

## Step 2 — Fund the contracts

- **FeeCollector**: needs 0.1 TON minimum for rent (already seeded by deploy script)
- **Factory**: needs 0.1 TON reserve + keeper pool (optional but recommended)

Fund keeper pool so keepers can earn bonus rewards:
```bash
# Send OP_FUND_KEEPER_POOL to factory address with 1+ TON
# This can be done via any TON wallet — no auth required
```

## Step 2 — Fund Factory keeper pool (optional but recommended)

Keepers earn a bonus reward when the factory keeper pool has funds. Seed it so external keepers are incentivised to charge your subscriptions:

```bash
# Send any amount ≥ 1 TON to your Factory with OP_FUND_KEEPER_POOL body.
# No authentication required — anyone can top up the pool.
```

---

## Step 3 — Configure the relayer

```bash
# Set environment variables for the relayer
export FACTORY_ADDRESS="EQD..."                        # Factory address from step 1b
export RELAYER_MNEMONIC="word1 word2 ..."              # Relayer key mnemonic
export POLL_INTERVAL_MS=60000                          # Poll every 60 seconds
export NETWORK=mainnet                                 # or testnet
export WEBHOOK_URL=https://yourapp.com/orbit/webhook  # optional

# If your Factory already has subscriptions from before this relayer run,
# list them here so the initial scan doesn't miss them.
# The relayer will also paginate through full factory history automatically.
export INITIAL_SUBSCRIPTIONS="EQDabc...,EQDdef..."    # optional

# Run the relayer
ts-node scripts/relayer.ts
```

For production, run the relayer as a managed process:
```bash
# Using pm2
npm install -g pm2
pm2 start "ts-node scripts/relayer.ts" --name orbit-relayer
pm2 save
pm2 startup
```

## Step 4 — Testnet first

**Always deploy to testnet before mainnet.**

```bash
export NETWORK=testnet
npx blueprint run deploy
```

Check the full cycle manually:
1. Subscribe from a test wallet
2. Wait for the relayer to charge (or manually send OP_CHARGE_EXT)
3. Cancel and verify refund
4. Test FeeCollector withdrawal (reduce `WITHDRAWAL_TIMELOCK_SEC` to 60 for testing)

## Updating contracts

ORBIT contracts are immutable once deployed. To update:
1. Deploy new Factory with updated `subCode`
2. Existing subscriptions continue running on the old code
3. New subscriptions deploy with the new code

There is intentionally no upgrade mechanism — immutability is a security property.

## Addresses reference (fill in after deployment)

| Contract | Testnet | Mainnet |
|---|---|---|
| FeeCollector | | |
| Factory | | |
| Relayer pubkey | | |

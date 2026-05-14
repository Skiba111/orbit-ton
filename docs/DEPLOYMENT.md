# Deployment Guide

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

## Step 1 — Deploy FeeCollector

```bash
npx blueprint run deploy
```

Follow the prompts:
1. Enter relayer pubkey (hex) when asked
2. Enter service owner address
3. Enter fee basis points (e.g. `20` = 0.2%)

The script deploys FeeCollector first, then Factory. Save the printed addresses.

## Step 2 — Fund the contracts

- **FeeCollector**: needs 0.1 TON minimum for rent (already seeded by deploy script)
- **Factory**: needs 0.1 TON reserve + keeper pool (optional but recommended)

Fund keeper pool so keepers can earn bonus rewards:
```bash
# Send OP_FUND_KEEPER_POOL to factory address with 1+ TON
# This can be done via any TON wallet — no auth required
```

## Step 3 — Configure the relayer

```bash
# Set environment variables for the relayer
export FACTORY_ADDRESS="EQD..."           # Factory address from step 1
export RELAYER_MNEMONIC="word1 word2 ..."  # Relayer key mnemonic
export POLL_INTERVAL_MS=60000              # Poll every 60 seconds
export NETWORK=mainnet                     # or testnet
export WEBHOOK_URL=https://yourapp.com/orbit/webhook  # optional

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

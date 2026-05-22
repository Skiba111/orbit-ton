# ORBIT Deployment Guide

## Two distinct roles — read this first

ORBIT separates **the protocol owner** (you, who runs the infrastructure) from
**service operators** (third-party developers who integrate ORBIT into their products).
These roles have different responsibilities and different keys.

```
ORBIT Protocol Owner (you)           Service Operators (third parties)
─────────────────────────────────    ─────────────────────────────────
• Run RELAYER on your server         • Deploy their own Factory contract
• Run KEEPER on your server          • Set their wallet as Factory owner
• Own protocolFeeCollector wallet    • Copy your RELAYER_PUBKEY from docs
• Publish RELAYER_PUBKEY in docs     • Copy your PROTOCOL_FEE_COLLECTOR
• Publish PROTOCOL_FEE_COLLECTOR     • Register in your dashboard
• Run the ORBIT Dashboard            • Build subscriber-facing apps with SDK
• Receive 1.5% from ALL charges      • Receive their own service fee
```

**You never give service operators your RELAYER_MNEMONIC or KEEPER_MNEMONIC.**
You only publish two values in your documentation:
- `RELAYER_PUBKEY` — so they can embed it in their Factory contract
- `PROTOCOL_FEE_COLLECTOR` address — so it gets baked into their Factory

---

## Published values (operators copy these)

> Keep this section updated. Service operators use these values when running `deploy-standalone.ts`.

| Value | Where to find it |
|---|---|
| `RELAYER_PUBKEY` | See below — generated from your `RELAYER_MNEMONIC` |
| `PROTOCOL_FEE_COLLECTOR` | Your cold wallet address (set once, immutable per Factory) |
| `REGISTRY_ADDRESS` | Printed by `deploy-registry.ts` |

```bash
# Print your RELAYER_PUBKEY (run on your server where RELAYER_MNEMONIC is set)
npx ts-node scripts/_get-pubkey.ts
```

---

## What gets deployed and by whom

| Contract | Deployed by | When |
|---|---|---|
| **FeeCollector** | ORBIT team (once) | Before Registry |
| **Registry** | ORBIT team (once) | After FeeCollector |
| **Factory** | Registry (automatically on registration) | Once per service operator |
| **Subscription** | Factory (automatically on subscribe) | Once per user per plan |

---

## Requirements

- Node.js 18+
- `ts-node` (installed via `npm install` in the repository)
- TON wallet with balance ≥ 2 TON
- Two Ed25519 keys (generated below)

---

## Step 0 — Generate keys

You need two separate keys:

| Key | Storage | Purpose |
|---|---|---|
| **Relayer key** | Hot (on server in `.env`) | Signs external messages `OP_CHARGE_EXT` |
| **Fee-collector key** | Cold (hardware / offline) | Signs withdrawals from FeeCollector |

```bash
# Generate relayer key
node -e "
const { mnemonicNew, mnemonicToPrivateKey } = require('@ton/crypto');
mnemonicNew(24).then(async m => {
    console.log('Mnemonic:', m.join(' '));
    const kp = await mnemonicToPrivateKey(m);
    console.log('Pubkey (hex):', Buffer.from(kp.publicKey).toString('hex'));
});
"
# Repeat for the fee-collector key — store the mnemonic offline
```

> **Important:** these are two different keys. The relayer key lives on the server. The fee-collector key stays offline.

---

## Step 1 — Configure .env

```env
# .env in the repository root — in .gitignore, NEVER commit this file

WALLET_MNEMONIC="word1 word2 ... word24"   # wallet that pays for deployment
FEE_COLLECTOR_PUBKEY="abcdef1234..."        # hex pubkey of the cold fee-collector key
RELAYER_PUBKEY="52dfadb8..."               # hex pubkey of the relayer key (baked into Registry)
TONCENTER_API_KEY="your_key"               # get one at toncenter.com
NETWORK=testnet                             # testnet | mainnet
WALLET_VERSION=v5                           # v5 = Tonkeeper/TG Wallet; v4 = older Tonkeeper
PLATFORM_FEE_BPS=0                         # extra platform fee on top of 1.5% protocol fee (0 = off)
```

Make sure the wallet has enough TON:
- **Testnet:** request test coins from @testgiver_ton_bot
- **Mainnet:** minimum 2 TON (1 for FeeCollector + 0.5 for Factory + buffer)

---

## Step 2 — Deploy FeeCollector and Registry  *(ORBIT operator only)*

> **Service developers skip this step** — use `register-service.ts` instead (see below).

This step is for the ORBIT platform operator who deploys the shared on-chain infrastructure once.

```bash
ts-node scripts/deploy-registry.ts
```

The script reads all parameters from `.env` (no interactive prompts). It:
1. Shows your wallet balance and seqno (errors if balance < 0.5 TON)
2. Compiles all Tolk contracts (~15 seconds)
3. Deploys FeeCollector (if not already deployed) and prints its address
4. Reads `RELAYER_PUBKEY` and `PLATFORM_FEE_BPS` from `.env`
5. Deploys Registry with `fee_collector = FeeCollector`, `relayer_pubkey`, and `platform_fee_bps` baked in
6. Prints Registry and FeeCollector addresses — copy them into `.env` and share the Registry address with service operators

**Example output:**
```
╔═══════════════════════════════════════════════════════════════╗
║              ORBIT Deploy Complete ✅                         ║
╠═══════════════════════════════════════════════════════════════╣
║  Network       : mainnet
║  FeeCollector  : EQD<fee_collector_address>
║  Registry      : EQD<registry_address>
╠═══════════════════════════════════════════════════════════════╣
║  → REGISTRY_ADDRESS=EQD<registry_address>  (share with devs) ║
╚═══════════════════════════════════════════════════════════════╝
```

### Alternative: standalone deploy (no Registry)

If you want to deploy a Factory directly without using the Registry:

```bash
ts-node scripts/deploy-standalone.ts
```

The script deploys FeeCollector + Factory in one flow and prompts interactively for parameters (owner address, service fee bps, relayer pubkey, protocol fee collector address). Use this for private setups where you do not need the shared Registry.

### For service operators — get a Factory via Registry

Once the ORBIT Registry is deployed, service operators get a Factory with a single transaction:

```bash
# Add to .env:
# REGISTRY_ADDRESS=EQD...  ← ORBIT Registry address (published by ORBIT team)
ts-node scripts/register-service.ts
```

This sends 0.3 TON to the Registry, which deploys a Factory for your wallet with ORBIT fee settings enforced at the contract level. Copy the printed Factory address into `FACTORY_ADDRESS` in your server `.env`.

---

## Step 3 — Server setup (VPS)

### Install Node.js and PM2

```bash
# Ubuntu 22.04
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2 ts-node typescript
```

### Clone and install dependencies

```bash
git clone https://github.com/Skiba111/orbit-ton.git ~/orbit
cd ~/orbit
npm install --legacy-peer-deps
```

### .env on the server

```bash
nano ~/orbit/.env
```

```env
# Server .env — relayer and webhook variables only
FACTORY_ADDRESS="EQD...your_factory_address..."
RELAYER_MNEMONIC="word1 word2 ... word24"   # relayer key mnemonic
NETWORK=mainnet                             # testnet | mainnet
POLL_INTERVAL_MS=60000
TONCENTER_API_KEY="your_key"

# Paths (optional — these are the defaults)
DB_PATH=data/subscriptions.json            # local subscription index
WAL_PATH=data/relayer-wal.json             # crash-safe charge intent journal

WEBHOOK_URL=https://api.yourapp.com/orbit/webhook
WEBHOOK_SECRET=long-random-string-at-least-32-chars
WEBHOOK_PORT=3001
LOG_FILE=data/charges.log
```

Generate a secure `WEBHOOK_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Start with PM2

```bash
cd ~/orbit

pm2 start "ts-node scripts/relayer.ts"     --name relayer
pm2 start "npm run webhook"                --name webhook

pm2 save       # save process list
pm2 startup    # enable autostart on reboot (run the command it prints)

# Verify
pm2 list
pm2 logs relayer --lines 30
```

### Reverse proxy (nginx + HTTPS)

```nginx
# /etc/nginx/sites-available/orbit
server {
    listen 443 ssl;
    server_name api.yourapp.com;

    ssl_certificate     /etc/letsencrypt/live/api.yourapp.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourapp.com/privkey.pem;

    location /orbit/ {
        proxy_pass       http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo certbot --nginx -d api.yourapp.com
sudo systemctl reload nginx
```

---

## Step 4 — E2E test (required before mainnet)

```bash
# Add to your local .env:
WEBHOOK_URL=https://api.yourapp.com/orbit/webhook
WEBHOOK_SECRET=same_string_as_on_server

ts-node scripts/test-e2e.ts
```

The test:
1. POSTs to the webhook (verifies reachability and secret)
2. Deploys a test Factory (period=120s, price=0.2 TON)
3. Creates a subscription with the correct message body format
4. Waits for the relayer to discover it and trigger the first charge

Monitor server logs:
```bash
pm2 logs relayer --lines 30
cat ~/orbit/data/charges.log
```

Expected output:
```
[relayer] Discovered subscription: EQD...
[relayer] Initial scan complete (1 pages, 1 subscriptions)
[relayer] Charged EQD... (seqno 0 → 1)
```

---

## Step 5 — Mainnet deployment

After a successful E2E test on testnet:

```bash
# In .env:
NETWORK=mainnet
TONCENTER_API_KEY="your_mainnet_key"   # separate API key for mainnet

# Wallet must have ≥ 2 real TON
ts-node scripts/deploy-standalone.ts
```

On the server, update `.env` and restart:
```bash
# Change NETWORK=mainnet and set FACTORY_ADDRESS to the mainnet address
nano ~/orbit/.env
pm2 restart relayer --update-env
pm2 restart webhook --update-env
```

---

## Updating server code

```bash
cd ~/orbit
git pull
pm2 restart relayer --update-env
pm2 restart webhook --update-env
```

---

## Upgrading contracts

ORBIT contracts are immutable after deployment. To upgrade:
1. Deploy a new Factory with updated `subCode`
2. Existing subscriptions continue running on the old code
3. New subscriptions are deployed with the new code
4. Update `FACTORY_ADDRESS` in the relayer `.env`

There is no upgrade mechanism by design — this is a security property. Subscribers can always verify the exact bytecode their contract runs.

---

## Address reference

After deployment, save your contract addresses for reference:

| Contract | Address |
|---|---|
| FeeCollector | *(printed by deploy script)* |
| Registry | *(printed by deploy script)* |
| Factory | *(printed after `register-service.ts`)* |

> Testnet and mainnet addresses are environment-specific and not published here.  
> Verify deployed contracts against the hashes in [BYTECODE_HASHES.md](BYTECODE_HASHES.md).

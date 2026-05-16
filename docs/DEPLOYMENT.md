# ORBIT Deployment Guide

## What gets deployed and by whom

| Contract | Deployed by | When |
|---|---|---|
| **FeeCollector** | ORBIT team (once) | Before any Factory |
| **Factory** | Service operator | Once per service |
| **Subscription** | Factory automatically | On each user subscribe |

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
TONCENTER_API_KEY="your_key"               # get one at toncenter.com
NETWORK=testnet                             # testnet | mainnet
WALLET_VERSION=v5                           # v5 = Tonkeeper/TG Wallet; v4 = older Tonkeeper
```

Make sure the wallet has enough TON:
- **Testnet:** request test coins from @testgiver_ton_bot
- **Mainnet:** minimum 2 TON (1 for FeeCollector + 0.5 for Factory + buffer)

---

## Step 2 — Deploy FeeCollector and Factory

```bash
ts-node scripts/deploy-standalone.ts
```

The script:
1. Shows your wallet balance and seqno (errors if < 0.5 TON)
2. Compiles all Tolk contracts (~15 seconds)
3. Deploys FeeCollector (if not already deployed)
4. Interactively prompts for Factory parameters:
   - **Service owner address** — your address (Factory management)
   - **Service fee bps** — service fee in basis points (100 = 1%, 0 = no fee)
   - **Relayer pubkey hex** — hex pubkey of the relayer key
   - **Protocol fee collector address** — FeeCollector address (or ORBIT address)
5. Deploys Factory
6. Prints the resulting addresses

**Example output:**
```
╔═══════════════════════════════════════════════════════════════╗
║                ORBIT Deployment Complete ✅                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Network      : testnet
║  FeeCollector : EQD<your_fee_collector_address>
║  Factory      : EQD<your_factory_address>
╠═══════════════════════════════════════════════════════════════╣
║  → Copy Factory address to FACTORY_ADDRESS in your .env      ║
╚═══════════════════════════════════════════════════════════════╝
```

### Alternative: deploy via Registry

If an ORBIT Registry is already deployed, skip step 2 entirely and register instead:

```bash
# Add to .env:
# REGISTRY_ADDRESS=EQD...  ← ORBIT Registry address
ts-node scripts/register-service.ts
```

This sends 0.3 TON to the Registry, which deploys a Factory for you with ORBIT fee settings enforced. Copy the printed Factory address into `FACTORY_ADDRESS`.

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
NETWORK=testnet
POLL_INTERVAL_MS=60000
TONCENTER_API_KEY="your_key"

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

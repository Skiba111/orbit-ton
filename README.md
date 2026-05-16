# ORBIT — Recurring Payments on TON

ORBIT is a modular smart-contract library for subscription billing on the TON blockchain. Any service can accept recurring payments in TON or Jetton tokens without building billing infrastructure from scratch.

```
Subscriber ──► Factory ──► Subscription ──► Service
                                │
                                └──► FeeCollector (protocol fee 1.5%)
```

> **Status (May 2026):** contracts deployed on testnet, E2E cycle confirmed — 6 successful charges verified via webhook. Mainnet deployment is next.

---

## Why ORBIT exists

**TON has no pull mechanism.** Unlike a credit card or bank account, you cannot debit a TON wallet without the owner signing every transaction. This means traditional recurring billing — charge the user automatically each month — is impossible on-chain without a dedicated contract.

The naive alternative is to ask users to pay manually each period. In practice this kills retention:

- Users who must re-approve a payment every month show **50%+ churn** compared to set-and-forget subscriptions.
- You cannot remind them — there are no push notifications tied to wallet addresses.
- Friction compounds: one missed period and the user is gone.

ORBIT solves this with a **deposit model**. The subscriber funds a personal Subscription contract once. After that, charges happen automatically — triggered by a relayer or any permissionless keeper — with no further action required from the user.

---

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Deployment](#deployment)
- [Backend integration](#backend-integration)
- [Build and tests](#build-and-tests)
- [Testnet addresses](#testnet-addresses)
- [Repository structure](#repository-structure)
- [Fees](#fees)
- [Security](#security)
- [License](#license)

---

## Features

- **TON and Jetton billing** — native coin or any TEP-74 token (e.g. USDT)
- **Deposit model** — subscriber pre-funds once; no pull payments, no repeated approvals
- **Keeper network** — any third party can trigger charges and earn a reward (permissionless)
- **Grace period + retry** — 3-day grace window before cancellation on insufficient funds
- **Fixed-term subscriptions** — optional `max_periods` cap with automatic cancellation
- **Plan change** — subscriber requests upgrade/downgrade; factory routes safely
- **Timelock withdrawals** — 24-hour delay on protocol fee withdrawals
- **Fully verifiable** — all money flows are deterministic and auditable on-chain
- **Registry integration** — one transaction to deploy a fully configured Factory

---

## Architecture

| Contract | Role |
|---|---|
| `Registry` | Entry point for service developers — deploys Factory with ORBIT fee settings enforced |
| `Factory` | Deploys Subscription contracts; stores plan registry; routes plan changes |
| `Subscription` | Per-user billing state; holds the subscriber's deposit |
| `FeeCollector` | Accumulates protocol fees; two-phase withdrawal with 24h timelock |

### Payment flow

```
Subscriber funds Subscription (at subscribe time)
     │
     ▼  every `period` seconds — triggered by relayer or keeper
Subscription.OP_CHARGE_EXT  ◄── external message with Ed25519 signature
     │
     ├── protocol_fee (1.5%, hardcoded in bytecode) ──► FeeCollector
     ├── service_fee  (fee_bps, set at Factory deploy) ──► fee_collector
     └── net_amount ────────────────────────────────────► Service wallet
```

### Key security properties

- The subscriber's deposit lives in **their own contract** — you never hold their funds.
- `fee_bps` and `fee_collector` are **immutable after Factory deploy** — baked in by Registry, cannot be changed by the service operator.
- The protocol fee (1.5%) is **hardcoded in Subscription bytecode** — impossible to bypass without recompiling, which changes the contract hash and makes it detectable.
- A compromised relayer key can trigger charges but **cannot steal funds** or modify state beyond a legitimate charge.

---

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/Skiba111/orbit-ton.git
cd orbit-ton
npm install
```

### 2. Configure .env

Create a `.env` file in the repository root:

```env
# .env — NEVER commit this file (it is in .gitignore)

# --- Deploy ---
WALLET_MNEMONIC="word1 word2 ... word24"     # wallet that pays for deployment
FEE_COLLECTOR_PUBKEY="abcdef1234..."          # hex Ed25519 pubkey for the fee-collector key
TONCENTER_API_KEY="your_key"                  # optional, increases rate limits
NETWORK=testnet                               # testnet | mainnet
WALLET_VERSION=v5                             # v4 | v5 (v5 = Tonkeeper)

# --- Relayer (on your server) ---
FACTORY_ADDRESS="EQD..."                      # address of the deployed Factory
RELAYER_MNEMONIC="word1 word2 ... word24"    # separate key for relayer
POLL_INTERVAL_MS=60000                        # polling interval in ms
WEBHOOK_URL=https://yourapp.com/orbit/webhook # URL for charge notifications
WEBHOOK_SECRET=long-random-string             # shared secret with webhook server
```

### 3. Build and test

```bash
npm test   # runs all tests in Blueprint sandbox
```

### 4. Register via Registry (recommended for service developers)

If an ORBIT Registry is already deployed, you do not need to deploy a Factory manually:

```bash
# Add to .env:
# REGISTRY_ADDRESS=EQD...  ← address of the ORBIT Registry
ts-node scripts/register-service.ts
# → Sends 0.3 TON to Registry
# → Registry deploys a Factory with your wallet as service_addr
# → Prints your Factory address — copy it into FACTORY_ADDRESS
```

### 4a. Manual Factory deploy (for the ORBIT operator)

```bash
ts-node scripts/deploy-standalone.ts
```

The script interactively prompts for Factory parameters and deploys FeeCollector + Factory. Output: addresses of both contracts.

### 5. E2E test (full cycle verification)

```bash
ts-node scripts/test-e2e.ts
```

Deploys a test Factory with period=120s, sends a subscribe transaction, verifies the webhook fires after the first charge.

---

## Deployment

Full guide: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**

Short version:
1. Generate two Ed25519 keys: one for the relayer (hot), one for the fee-collector (cold, stored offline).
2. Deploy via `ts-node scripts/deploy-standalone.ts`.
3. Run the relayer and webhook server on a VPS (PM2 recommended for process management).

---

## Backend integration

### Sending a subscription (frontend → Factory)

```typescript
import { beginCell, toNano } from "@ton/core";

// Message body: op(32) + query_id(64) + plan_id(32) + payment_type(2)
// PAYMENT_TON = 1,  PAYMENT_JETTON = 2  (0 is INVALID)
const body = beginCell()
    .storeUint(0x4F520001, 32)  // OP_SUBSCRIBE
    .storeUint(0,           64)  // query_id (0 is fine)
    .storeUint(0,           32)  // plan_id = 0 (first plan)
    .storeUint(1,            2)  // payment_type = TON (must be 1, not 0)
    .endCell();

// value = plan_price + at least 0.1 TON (gas + storage reserve)
// Recommended: plan_price + 0.2 TON
await tonconnect.sendTransaction({
    messages: [{
        address: FACTORY_ADDRESS,
        amount:  String(toNano("0.4")),   // for a 0.2 TON plan
        payload: body.toBoc().toString("base64"),
    }],
});
```

### Receiving charge events (webhook)

After each confirmed charge, the relayer sends a POST to `WEBHOOK_URL`:

```json
{
  "event":      "charge_confirmed",
  "address":    "EQAem3BPC7PvJzPGItrwNDVizMSqFIZ0nUDZvebfB4NBDn5w",
  "seqno_from": 0,
  "seqno_to":   1,
  "timestamp":  1747374000
}
```

`address` is the subscriber's Subscription contract address. Use it to look up the user and grant access in your system.

Ready-to-use webhook server: [`scripts/webhook-server.ts`](scripts/webhook-server.ts)

### Checking subscription status (on-chain)

```typescript
import { TonClient, Address } from "@ton/ton";
import { Subscription }       from "./wrappers/Subscription";

const client = new TonClient({
    endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
    apiKey:   process.env.TONCENTER_API_KEY,
});

const sub = client.open(
    Subscription.createFromAddress(Address.parse("EQD...subscription_address..."))
);

const status      = await sub.getStatus();           // 1=TRIAL 2=ACTIVE 3=PAUSED 4=GRACE 5=CANCELLED
const seqno       = await sub.getSeqno();            // number of successful charges
const nextBilling = await sub.getNextBillingTime();  // unix timestamp of next charge
```

Full guide: **[docs/INTEGRATION.md](docs/INTEGRATION.md)**

---

## Build and tests

```bash
npm install
npm test                       # unit + integration tests (Blueprint sandbox)
ts-node scripts/test-e2e.ts    # E2E on testnet (requires .env with real keys)
```

Test suite: 71 tests across security, integration, and Registry scenarios.

---

## Testnet addresses

| Contract | Address |
|---|---|
| FeeCollector | `EQDDU30Vfvjf4wVgyw5Mzh3aMmcvP7Y0sFb2zQ-2tTNbadze` |
| Factory (production: 1 TON/month + 5 TON/month plans) | `EQADc2gC0KFW-vNPeHJ18EFG81YMBWwR6qQsbSSaWCUmQuJ2` |
| Factory (E2E test: 0.2 TON / 2 min) | `EQDYJOcdv9C_Uf3tNqCvgPuAQT-hVxLdOEfJePtSiR_YjVCS` |
| Relayer pubkey | `52dfadb8e95cfce76eb724f79758ad9c06117913f3a080f7f749d130216338a8` |

> Mainnet addresses will be published after mainnet deployment.

---

## Repository structure

```
contracts/              Tolk contracts: Subscription, Factory, Registry, FeeCollector
billing/                Billing engine, fee router, retry scheduler
payment/                Payment adapters: TON and Jetton
plans/                  Plan registry and trial period logic
core/                   Storage schema, period arithmetic, subscription state
access/                 Role manager, emergency pause
utils/                  Error codes, opcodes, math helpers, time oracle
wrappers/               TypeScript wrappers for Blueprint/sandbox tests
tests/                  Security, integration, and Registry test suites
scripts/
  deploy-standalone.ts  Deploy FeeCollector + Factory (no Blueprint, via TonCenter REST)
  register-service.ts   Register through Registry to get a managed Factory
  relayer.ts            Charge relayer: WAL, exponential backoff, webhook, keeper mode
  webhook-server.ts     Example webhook receiver for your backend
  test-e2e.ts           E2E test: deploy test Factory → subscribe → charge → webhook
  patch-ton-core.ts     domainSign polyfill for @ton/core@0.56.x + @ton/ton@16
sdk/react/              @orbit-ton/react — React hooks and components (not yet published)
docs/                   Developer documentation
```

---

## Fees

Every billing cycle deducts **two fees** from the plan amount before sending to the service:

| Fee | Set by | Destination | Value |
|---|---|---|---|
| **Service fee** | Factory operator (`fee_bps`) | Factory's `fee_collector` | 0 – 10% (configurable) |
| **Protocol fee** | Hardcoded in bytecode (`PROTOCOL_FEE_BPS = 150`) | ORBIT `protocol_fee_collector` | 1.5% (fixed) |

**Example** — plan price 1 TON/month, service fee = 0% (default):
- Gross: 1.000 TON
- Protocol fee (1.5%): 0.015 TON → ORBIT
- Service fee (0%): 0.000 TON
- **Service receives**: 0.993 TON

The protocol fee is compiled into the Subscription bytecode — it cannot be modified without recompiling, which produces a different contract hash and is trivially detectable on-chain.

Full fee model: [docs/PROTOCOL_FEE.md](docs/PROTOCOL_FEE.md)

---

## Security

| Protection | Mechanism |
|---|---|
| Replay attacks | seqno + 60s timestamp window on all external messages |
| Double charge | `charging_in_progress` flag for Jetton; `next_billing_time` for TON |
| Storage depletion | `raw_reserve(storage_reserve, 0)` before every send |
| Bounce recovery | Deposit is restored if a payment message bounces |
| Key compromise | 24h timelock on FeeCollector withdrawals |
| Subscription spoofing | Factory stores `sub_addr` in `subscriber_info` — address is never taken from the caller |
| Fee bypass | `fee_bps` is immutable after Factory deploy; `split_fee()` asserts cap at charge time |
| Jetton griefing | TON deposits only update `deposit` when `payment_type == PAYMENT_TON` |

Full details: [docs/SECURITY.md](docs/SECURITY.md)

---

## License

[Business Source License 1.1](LICENSE) — free for non-commercial use.  
Converts to MIT on **2029-05-15**.  
Commercial licensing: skibatima9@gmail.com
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   
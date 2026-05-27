<div align="center">

# ORBIT

**Recurring subscription billing on the TON blockchain**

[![License: BUSL-1.1](https://img.shields.io/badge/license-BUSL--1.1-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-83%20passing-brightgreen.svg)](tests/)
[![TON](https://img.shields.io/badge/blockchain-TON-0098EA.svg)](https://ton.org)
[![Language](https://img.shields.io/badge/language-Tolk-informational.svg)](https://docs.ton.org/v3/documentation/smart-contracts/tolk/overview)
[![Status](https://img.shields.io/badge/status-mainnet%20live-brightgreen.svg)]()

**Dashboard:** [app.orbit-ton.com](https://app.orbit-ton.com/) &nbsp;|&nbsp;
**Landing:** [skiba111.github.io/orbit-ton](https://skiba111.github.io/orbit-ton/) &nbsp;|&nbsp;
**Mini App:** [@orbit_subpay_bot](https://t.me/orbit_subpay_bot)

</div>

---

> **TON has no pull mechanism.** You cannot debit a wallet without the owner signing every transaction. ORBIT solves this with a deposit model — the subscriber funds a personal contract once, then charges happen automatically every billing period with no further action required.

---

## Table of Contents

- [What is ORBIT](#what-is-orbit)
- [Architecture](#architecture)
- [Contract Roles](#contract-roles)
- [How It Works](#how-it-works)
- [Getting Started (Dashboard)](#getting-started-dashboard)
- [REST API](#rest-api)
- [Webhooks](#webhooks)
- [Withdrawal Scripts](#withdrawal-scripts)
- [Features](#features)
- [Fee Model](#fee-model)
- [Security](#security)
- [Repository Layout](#repository-layout)
- [Build & Tests](#build--tests)
- [Documentation](#documentation)
- [License](#license)

---

## What is ORBIT

ORBIT is a smart-contract protocol for recurring subscription billing on the TON blockchain. It lets any service — a SaaS, a Telegram mini app, a DeFi product — collect periodic payments in TON or Jetton tokens from subscribers without requiring repeated wallet approvals.

Key properties:

- **Deposit model** — subscribers pre-fund a personal Subscription contract; billing runs automatically
- **No pull payments** — the service never holds subscriber keys or open-ended approvals
- **Permissionless keeper network** — anyone can trigger charges and earn a small reward
- **Fully on-chain fee enforcement** — protocol fee (1.5%) is hardcoded in bytecode; cannot be bypassed
- **Grace period** — 3-day window for low-balance subscriptions before cancellation

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           ORBIT Protocol                            │
│                                                                     │
│  Service operator                                                   │
│       │                                                             │
│       │  OP_REGISTRY_REGISTER (min 0.2 TON, 0.3 TON recommended)   │
│       ▼                                                             │
│  ┌──────────┐   deploys   ┌─────────────────────────────────────┐  │
│  │ Registry │ ──────────► │ Factory          (per service)      │  │
│  │          │             │                                     │  │
│  │ Enforces │             │  • Plan registry (prices/periods)   │  │
│  │ fee_bps  │             │  • subscriber_info dict             │  │
│  │ globally │             │  • Keeper reward pool               │  │
│  └──────────┘             └──────────────┬──────────────────────┘  │
│                                          │                          │
│  Subscriber                              │  OP_SUBSCRIBE            │
│       │                                  │  (deploys + funds)       │
│       └─────────────────────────────────►│                          │
│                                          ▼                          │
│                             ┌────────────────────────┐             │
│                             │ Subscription (per user) │             │
│                             │                        │             │
│                             │  deposit  ──► charges  │             │
│                             │  seqno    ──► billing  │             │
│                             └──────────┬─────────────┘             │
│                                        │                            │
│              OP_CHARGE_EXT ────────────┘                            │
│              (relayer or keeper, every period)                      │
│                                        │                            │
│                 ┌──────────────────────┼──────────────┐            │
│                 ▼                      ▼              ▼            │
│          ┌────────────┐       ┌──────────────┐  ┌──────────────┐  │
│          │  Service   │       │  service fee │  │ protocol fee │  │
│          │  wallet    │       │  collector   │  │ FeeCollector │  │
│          │ (net amt)  │       │ (configurable│  │ (1.5% fixed) │  │
│          └────────────┘       │  0 – 10%)    │  └──────────────┘  │
│                               └──────────────┘                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Contract Roles

| Contract | Deployed by | Role |
|---|---|---|
| **Registry** | ORBIT team (once) | Entry point — deploys a Factory per service with enforced fee settings |
| **Factory** | Registry (per service) | Holds plans, deploys Subscriptions, routes plan changes, manages keeper pool |
| **Subscription** | Factory (per user) | Holds the subscriber's deposit; executes billing cycles |
| **FeeCollector** | ORBIT team (once) | Accumulates protocol fees; 24h timelock on withdrawals |

**Mainnet contract addresses:**

| Contract | Address |
|---|---|
| Registry | `EQAYj1s3g71yta1XaJUeCTEjMRtTBEzHL12-qBIQ4kSNSA_5` |
| FeeCollector | `EQDXmTHoJvjahldT3_tpeGcZ0juiADEfhTBiKcQuFPnjz6S0` |

Verify deployed contracts against the published bytecode hashes: [docs/BYTECODE_HASHES.md](docs/BYTECODE_HASHES.md)

---

## How It Works

```
① Subscriber sends OP_SUBSCRIBE to Factory
     │
     │  value = plan_price + 0.2 TON (gas + reserve)
     ▼
② Factory deploys Subscription contract
     │
     │  deposit = value − deploy_gas
     ▼
③ Subscription is ACTIVE (or TRIAL if plan has trial period)

④ Every `period` seconds — triggered by relayer or keeper:

   Subscription.recv_external(OP_CHARGE_EXT)
        │
        ├─► net_amount (plan_price × (1 − fee_bps/10000 − 0.015)) ──► service wallet
        ├─► service_fee (fee_bps)                           ──► fee_collector
        ├─► protocol_fee (1.5%)                             ──► FeeCollector
        └─► OP_CHARGE_NOTIFICATION                          ──► Factory (MRR counter)

⑤ If deposit runs out → GRACE (3 days) → CANCELLED → refund remaining deposit
```

---

## Getting Started (Dashboard)

The easiest way to integrate ORBIT is through the dashboard at [app.orbit-ton.com](https://app.orbit-ton.com/).

### Step 1 — Register your service

1. Open the [ORBIT Dashboard](https://app.orbit-ton.com/) and connect your TON wallet (Tonkeeper or Telegram Wallet).
2. Go to **Services → Register Service**.
3. The dashboard sends a `OP_REGISTRY_REGISTER` transaction (0.3 TON) to the ORBIT Registry on your behalf.
4. The Registry deploys a **Factory** contract owned by your wallet with the ORBIT protocol fee enforced at the contract level.
5. Copy the printed Factory address — you will need it for plan configuration and subscriber links.

### Step 2 — Create subscription plans

1. In the Dashboard, open your service and go to **Plans → Add Plan**.
2. Specify the plan name, price (in TON), and billing period (e.g. 30 days).
3. The dashboard calls `add-plan` on your Factory contract.
4. Repeat for each plan tier you want to offer.

Alternatively, add plans via the TypeScript SDK:

```typescript
import { Factory } from "./wrappers/Factory";
import { toNano } from "@ton/core";

const factory = client.open(Factory.createFromAddress(Address.parse(FACTORY_ADDRESS)));
await factory.sendAddPlan(wallet.getSender(), {
    price:       toNano("5"),   // 5 TON per period
    period:      2592000,       // 30 days in seconds
    trialPeriod: 604800,        // 7-day free trial
    nameHash:    0n,
});
```

### Step 3 — Share the payment link

After creating plans, the Dashboard generates a subscription payment link for your Telegram Mini App or website. Share the link with potential subscribers — when they tap it, the [ORBIT Mini App](https://t.me/orbit_subpay_bot) opens and walks them through subscribing.

### Step 4 — Get an API key

1. In the Dashboard, go to **API Keys → Create Key**.
2. Choose a name, optionally scope it to a specific service.
3. **Copy the key immediately** — it is shown only once.
4. Use the key in your backend with the `X-API-Key` header:

```
X-API-Key: orbit_sk_<your_key>
```

API keys are used for server-to-server integrations: reading subscription status, listing charge history, registering webhooks, and accessing analytics.

---

## REST API

Base URL: `https://api.orbit-ton.com/api/v1`

### Authentication

Two methods are supported:

| Method | Header | When to use |
|---|---|---|
| **API Key** | `X-API-Key: orbit_sk_<key>` | Server-to-server integrations |
| **JWT Bearer** | `Authorization: Bearer <token>` | Browser / dashboard sessions (obtained via TON Connect proof) |

### Key endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/services` | List your registered services |
| `POST` | `/services/claim` | Register a deployed Factory as your service |
| `GET` | `/services/:id/plans` | List plans for a service |
| `POST` | `/services/:id/plans` | Sync an on-chain plan into the dashboard |
| `GET` | `/services/:id/subscriptions` | List subscriptions (paginated) |
| `GET` | `/services/:id/subscriptions/:subId` | Get a single subscription with charge history |
| `GET` | `/services/:id/charges` | List charge history |
| `GET` | `/services/:id/charges/export` | Download charges as CSV |
| `GET` | `/services/:id/analytics/overview` | MRR, churn, active subscriber counts |
| `GET` | `/services/:id/analytics/charges` | Daily revenue chart data |
| `POST` | `/services/:id/webhooks` | Register a webhook endpoint |
| `GET` | `/api-keys` | List your API keys |
| `POST` | `/api-keys` | Create a new API key |

Full API reference with request/response schemas: [docs/API.md](docs/API.md)

---

## Webhooks

ORBIT delivers lifecycle events to your backend via HTTP POST.

### Registering an endpoint

```bash
curl -X POST https://api.orbit-ton.com/api/v1/services/<serviceId>/webhooks \
  -H "X-API-Key: orbit_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://yourapp.com/orbit/webhook", "events": ["charge.success", "subscription.activated"]}'
```

The response includes a `secret` field — **copy it immediately**, it is shown only once.

### Available events

| Event | When |
|---|---|
| `charge.success` | Charge collected successfully |
| `charge.failed` | Charge attempt failed |
| `subscription.activated` | New subscriber created |
| `subscription.cancelled` | Subscriber cancelled |
| `subscription.grace` | Grace period started (deposit too low) |
| `subscription.recovered` | Deposit topped up, subscription resumed |

### Verifying deliveries

Every delivery includes an `X-Orbit-Signature: sha256=<hex>` header. Verify it before trusting the payload:

```typescript
import { verifyWebhookSignature } from "@orbit-ton/react";

app.post("/orbit/webhook", async (req, res) => {
  const isValid = await verifyWebhookSignature(
    req.body,                              // raw body string before JSON.parse
    req.headers["x-orbit-signature"],
    process.env.ORBIT_WEBHOOK_SECRET,
  );
  if (!isValid) return res.status(401).end();

  const event = JSON.parse(req.body);
  if (event.event === "charge.success") {
    await grantAccess(event.subscriptionAddress, event.seqnoTo);
  }
  res.status(200).end("OK");
});
```

**Retry policy:** failed deliveries are retried up to 5 times with exponential backoff (30s → 2m → 8m → 32m → 2h).

Full webhook and integration details: [docs/INTEGRATION.md](docs/INTEGRATION.md)

---

## Withdrawal Scripts

Protocol fees accumulate in the `FeeCollector` contract and are withdrawn manually using a two-phase timelock script located in the backend package.

The script requires interactive mnemonic entry — the seed phrase is never written to disk.

### Phase 1 — Schedule withdrawal (starts 24h timelock)

```bash
cd backend
node withdraw-fees.mjs 1 <DESTINATION_ADDRESS>
```

Enter the FeeCollector cold key mnemonic when prompted. The script verifies the pubkey matches before sending anything.

### Phase 2 — Confirm withdrawal (run after 24h have elapsed)

```bash
cd backend
node withdraw-fees.mjs 2
```

Enter the same mnemonic again. The script checks that the timelock has elapsed before sending the confirmation.

**Security properties of the withdrawal flow:**
- Mnemonic is entered interactively and never stored
- Script validates pubkey against the on-chain contract before proceeding
- 24h delay between schedule and execute gives time to detect and rotate a compromised key
- Confirmation requires the same key — rotating the key via `OP_ROTATE_KEY` cancels any pending withdrawal

---

## Features

| Feature | Details |
|---|---|
| **TON & Jetton billing** | Native coin or any TEP-74 token (USDT, USDC, etc.) |
| **Deposit model** | Subscriber pre-funds once; no pull payments, no repeated approvals |
| **Permissionless keeper network** | Any third party can trigger charges and earn a reward |
| **Grace period + retry** | 3-day grace window, up to 5 charge retries |
| **Fixed-term subscriptions** | Optional `max_periods` cap with automatic refund on expiry |
| **Plan upgrade / downgrade** | Subscriber requests plan change; Factory routes it safely |
| **Registry integration** | One transaction to get a fully configured Factory |
| **Trial periods** | Per-plan free trial, one-time per subscriber per Factory |
| **Bounce recovery** | Deposit is always restored if a payment message bounces |
| **24h withdrawal timelock** | FeeCollector requires a 24h delay before funds can move |
| **Immutable fee_bps** | Platform fee is locked at Factory deploy — no bait-and-switch |
| **Fully auditable** | All money flows are deterministic and verifiable on-chain |

---

## Fee Model

Every billing cycle deducts **two fees** from the gross amount:

```
Gross amount (plan price)
    │
    ├── Protocol fee  (1.5% — hardcoded in bytecode) ──► ORBIT FeeCollector
    ├── Service fee   (0–10% — set at Factory deploy) ──► service fee_collector
    └── Net amount                                    ──► service wallet
```

| Fee | Who sets it | Where it goes | Range |
|---|---|---|---|
| **Protocol fee** | Hardcoded — `PROTOCOL_FEE_BPS = 150` | ORBIT `FeeCollector` | 1.5% fixed |
| **Service fee** | Factory operator (`fee_bps`) | Service's `fee_collector` | 0 – 10% |

**Example** — plan = 10 TON/month, service fee = 3%:

| | Amount |
|---|---|
| Gross | 10.000 TON |
| Protocol fee (1.5%) | − 0.150 TON |
| Service fee (3%) | − 0.300 TON |
| **Service receives** | **9.550 TON** |

The protocol fee is compiled into every Subscription's bytecode. It is enforced at runtime on every charge and cannot be altered in any deployed contract.

Full fee mechanics: [docs/PROTOCOL_FEE.md](docs/PROTOCOL_FEE.md)

---

## Security

| Threat | Protection |
|---|---|
| **Replay attack** | `seqno` monotonicity + 60 s timestamp window on all external messages |
| **Double charge** | `charging_in_progress` flag (Jetton async guard) · `next_billing_time` check |
| **Storage depletion** | `raw_reserve(storage_reserve)` called before every outgoing message |
| **Bounced payment** | `on_charge_bounced` restores full deposit; billing clock rolled back |
| **Key compromise** | 24h timelock on FeeCollector; `OP_ROTATE_KEY` cancels pending withdrawal |
| **Address spoofing** | `OP_CHANGE_PLAN` — Factory reads `sub_addr` from its own dict, not from caller |
| **Fee bypass** | `fee_bps` immutable after Factory deploy; `split_fee()` asserts cap at runtime |
| **Jetton inflation griefing** | Empty-body TON only updates `deposit` when `payment_type == PAYMENT_TON` |
| **Keeper pool drain** | `OP_CHARGE_NOTIFICATION` authenticated: sender must match stored `sub_addr` |
| **Gas drain via plan change** | `OP_CHANGE_PLAN` requires `msg_value ≥ 0.05 TON` before forwarding |

Full threat model with 23 documented properties: [docs/SECURITY.md](docs/SECURITY.md)

---

## Repository Layout

```
orbit-ton/
│
├── contracts/               ← Top-level smart contracts (Tolk)
│   ├── subscription.tolk    ← Per-user billing contract
│   ├── factory.tolk         ← Per-service plan + deploy manager
│   ├── registry.tolk        ← ORBIT platform entry point
│   └── fee-collector.tolk   ← Protocol fee accumulator (24h timelock)
│
├── billing/                 ← Charge engine, fee routing, grace/retry logic
├── payment/                 ← TON and Jetton payment adapters
├── plans/                   ← Plan storage, trial logic
├── core/                    ← Storage layout, state codes, billing math
├── access/                  ← Owner/subscriber access control, pause toggle
├── utils/                   ← Error codes, opcodes, math helpers, protocol config
│
├── wrappers/                ← TypeScript contract wrappers (Blueprint / tests)
│   ├── Subscription.ts
│   ├── Factory.ts
│   ├── Registry.ts
│   └── FeeCollector.ts
│
├── tests/                   ← Jest test suites (83 tests)
│   ├── subscription.spec.ts    ← Unit tests: all subscription ops
│   ├── security.spec.ts        ← Exploit attempts and edge cases
│   ├── integration.spec.ts     ← Full billing cycle: subscribe → charge → cancel
│   ├── registry.spec.ts        ← Registry: deploy, register, deregister, admin
│   └── fee-collector.spec.ts   ← FeeCollector: timelock, key rotation, withdraw
│
├── scripts/
│   ├── deploy-registry.ts      ← Deploy FeeCollector + Registry (ORBIT operator)
│   ├── deploy-standalone.ts    ← Deploy FeeCollector + Factory directly (no Registry)
│   ├── register-service.ts     ← Register via Registry to get a managed Factory
│   ├── add-plan.ts             ← Add a subscription plan to a Factory
│   ├── test-subscribe.ts       ← Send a test OP_SUBSCRIBE to a Factory
│   ├── cancel-subscription.ts  ← Send OP_CANCEL to recover subscriber deposit
│   ├── relayer.ts              ← Charge relayer: WAL, backoff, webhook, keeper mode
│   ├── webhook-server.ts       ← Example webhook receiver for your backend
│   └── test-e2e.ts             ← E2E test: subscribe → charge → webhook on testnet
│
├── sdk/react/               ← @orbit-ton/react — published hooks, components and REST client
│
└── docs/
    ├── QUICKSTART.md        ← 10-minute onboarding
    ├── INTEGRATION.md       ← Full integration guide with code examples
    ├── API.md               ← REST API reference
    ├── DEPLOYMENT.md        ← Server and mainnet deployment guide
    ├── SECURITY.md          ← Threat model, all 23 security properties
    ├── PROTOCOL_FEE.md      ← Fee mechanics and invariants
    ├── WHITEPAPER.md        ← Protocol design decisions
    ├── CONFIGURATION.md     ← All configurable parameters
    ├── KEEPER.md            ← Keeper network overview
    └── BYTECODE_HASHES.md   ← Published contract hashes for verification
```

---

## Build & Tests

```bash
npm install
npm test                       # 83 tests — security · integration · registry
ts-node scripts/test-e2e.ts    # E2E on testnet (requires .env with real keys)
```

---

## Documentation

| Document | Contents |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | 10-minute onboarding for service developers |
| [INTEGRATION.md](docs/INTEGRATION.md) | Subscribe message format, webhook events, status getters, subscriber actions, React SDK |
| [API.md](docs/API.md) | Full REST API reference |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Key generation, server setup, PM2, nginx, mainnet checklist |
| [SECURITY.md](docs/SECURITY.md) | Threat model and all 23 security properties |
| [PROTOCOL_FEE.md](docs/PROTOCOL_FEE.md) | Fee split mechanics, invariants, bounced fee recovery |
| [WHITEPAPER.md](docs/WHITEPAPER.md) | Protocol design decisions and architecture rationale |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | All tunable parameters and their defaults |
| [KEEPER.md](docs/KEEPER.md) | Keeper network: permissionless vs. relayer mode, rewards |
| [BYTECODE_HASHES.md](docs/BYTECODE_HASHES.md) | Published contract hashes for independent verification |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

---

## License

[Business Source License 1.1](LICENSE) — free for non-commercial use.  
Converts to MIT on **2029-05-15**.  
Commercial licensing: see [LICENSE](LICENSE) for contact details.

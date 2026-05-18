<div align="center">

# ORBIT

**Recurring subscription billing on the TON blockchain**

[![License: BUSL-1.1](https://img.shields.io/badge/license-BUSL--1.1-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-83%20passing-brightgreen.svg)](tests/)
[![TON](https://img.shields.io/badge/blockchain-TON-0098EA.svg?logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMTIgMkM2LjQ4IDIgMiA2LjQ4IDIgMTJzNC40OCAxMCAxMCAxMCAxMC00LjQ4IDEwLTEwUzE3LjUyIDIgMTIgMnoiIGZpbGw9IndoaXRlIi8+PC9zdmc+)](https://ton.org)
[![Language](https://img.shields.io/badge/language-Tolk-informational.svg)](https://docs.ton.org/v3/documentation/smart-contracts/tolk/overview)
[![Status](https://img.shields.io/badge/status-mainnet%20live-brightgreen.svg)]()

</div>

---

> **TON has no pull mechanism.** You cannot debit a wallet without the owner signing every transaction. ORBIT solves this with a deposit model — the subscriber funds a personal contract once, then charges happen automatically every billing period with no further action required.

---

## Table of Contents

- [Architecture](#architecture)
- [How it works](#how-it-works)
- [Features](#features)
- [Quick Start](#quick-start)
- [Repository Layout](#repository-layout)
- [Fee Model](#fee-model)
- [Security](#security)
- [Documentation](#documentation)
- [License](#license)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           ORBIT Protocol                            │
│                                                                     │
│  Service operator                                                   │
│       │                                                             │
│       │  OP_REGISTRY_REGISTER (0.3 TON)                            │
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

### Contract roles

| Contract | Deployed by | Role |
|---|---|---|
| **Registry** | ORBIT team (once) | Entry point — deploys a Factory per service with enforced fee settings |
| **Factory** | Registry (per service) | Holds plans, deploys Subscriptions, routes plan changes, manages keeper pool |
| **Subscription** | Factory (per user) | Holds the subscriber's deposit; executes billing cycles |
| **FeeCollector** | ORBIT team (once) | Accumulates protocol fees; 24h timelock on withdrawals |

---

## How it works

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

## Features

| Feature | Details |
|---|---|
| **TON & Jetton billing** | Native coin or any TEP-74 token (USDT, USDC, etc.) |
| **Deposit model** | Subscriber pre-funds once; no pull payments, no repeated approvals |
| **Permissionless keeper network** | Any third party can trigger charges and earn a reward |
| **Grace period + retry** | 3-day grace window, up to 5 charge retries (relayer uses exponential backoff) |
| **Fixed-term subscriptions** | Optional `max_periods` cap with automatic refund on expiry |
| **Plan upgrade / downgrade** | Subscriber requests plan change; Factory routes it safely |
| **Registry integration** | One transaction to get a fully configured Factory |
| **Trial periods** | Per-plan free trial, one-time per subscriber per Factory |
| **Bounce recovery** | Deposit is always restored if a payment message bounces |
| **24h withdrawal timelock** | FeeCollector requires a 24h delay before funds can move |
| **Immutable fee_bps** | Platform fee is locked at Factory deploy — no bait-and-switch |
| **Fully auditable** | All money flows are deterministic and verifiable on-chain |

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/Skiba111/orbit-ton.git
cd orbit-ton
npm install
```

### 2. Configure `.env`

```bash
cp .env.example .env
# Fill in WALLET_MNEMONIC, REGISTRY_ADDRESS, and NETWORK
```

All parameters and their defaults are documented in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### 3. Run tests

```bash
npm test
# → 83 tests: security · integration · registry
```

### 4. Get a Factory (service operators)

```bash
# Set REGISTRY_ADDRESS in .env, then:
ts-node scripts/register-service.ts
# → Sends 0.3 TON to Registry
# → Registry deploys your Factory with enforced fee settings
# → Prints Factory address → copy to FACTORY_ADDRESS in .env
```

### 5. Subscribe (frontend)

```typescript
import { beginCell, toNano } from "@ton/core";

// TON subscription — plan 0
const body = beginCell()
    .storeUint(0x4F520001, 32)   // OP_SUBSCRIBE
    .storeUint(0,           64)   // query_id
    .storeUint(0,           32)   // plan_id = 0
    .storeUint(1,            2)   // PAYMENT_TON = 1  (not 0!)
    .endCell();

// value = plan_price + at least 0.1 TON (recommended: + 0.2 TON)
await tonConnectUI.sendTransaction({
    messages: [{
        address: FACTORY_ADDRESS,
        amount:  String(planPrice + toNano("0.2")),
        payload: body.toBoc().toString("base64"),
    }],
});
```

### 6. Receive charge events (backend)

```typescript
// POST to WEBHOOK_URL after each confirmed charge:
// {
//   "event":      "charge_confirmed",
//   "address":    "EQD...",  ← subscriber's Subscription address
//   "seqno_from": 2,
//   "seqno_to":   3,
//   "timestamp":  1747374000
// }

app.post("/orbit/webhook", (req, res) => {
    if (req.headers["X-Orbit-Secret"] !== process.env.WEBHOOK_SECRET) {
        return res.status(401).end();
    }
    const { address, seqno_to } = req.body;
    // look up user by address, grant access for another billing period
    grantAccess(address, seqno_to);
    res.status(200).end("OK");
});
```

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
│   ├── test-e2e.ts             ← E2E test: subscribe → charge → webhook on testnet
│   ├── _get-pubkey.ts          ← Print wallet address and pubkey hex from mnemonic
│   ├── _compute-hashes.ts      ← Recompute and print bytecode hashes for verification
│   └── patch-ton-core.ts       ← domainSign polyfill (@ton/core 0.56.x compat)
│
├── sdk/react/               ← @orbit-ton/react hooks and components (in dev)
│
└── docs/
    ├── QUICKSTART.md        ← 10-minute onboarding
    ├── INTEGRATION.md       ← Full integration guide with code examples
    ├── DEPLOYMENT.md        ← Server and mainnet deployment guide
    ├── SECURITY.md          ← Threat model, all 23 security properties
    ├── PROTOCOL_FEE.md      ← Fee mechanics and invariants
    ├── WHITEPAPER.md        ← Protocol design decisions
    ├── CONFIGURATION.md     ← All configurable parameters
    ├── KEEPER.md            ← Keeper network overview
    └── BYTECODE_HASHES.md   ← Published contract hashes for verification
```

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

The protocol fee is compiled into every Subscription's bytecode. It is enforced at runtime on every charge and cannot be altered in any deployed contract. Any contract not matching the official ORBIT code hash is immediately identifiable on-chain.

Full fee mechanics: [docs/PROTOCOL_FEE.md](docs/PROTOCOL_FEE.md)

---

## Security

| Threat | Protection |
|---|---|
| **Replay attack** | `seqno` monotonicity + 60 s timestamp window on all external messages |
| **Double charge** | `charging_in_progress` flag (Jetton async guard) · `next_billing_time` check (TON and Jetton) |
| **Storage depletion** | `raw_reserve(storage_reserve)` called before every outgoing message |
| **Bounced payment** | `on_charge_bounced` restores full deposit; billing clock rolled back |
| **Key compromise** | 24h timelock on FeeCollector; relayer key can only trigger valid charges |
| **Address spoofing** | `OP_CHANGE_PLAN` — Factory reads `sub_addr` from its own dict, not from caller |
| **Fee bypass** | `fee_bps` immutable after Factory deploy; `split_fee()` asserts cap at runtime |
| **Jetton inflation griefing** | Empty-body TON only updates `deposit` when `payment_type == PAYMENT_TON` |
| **Keeper pool drain** | `OP_CHARGE_NOTIFICATION` authenticated: sender must match stored `sub_addr` |
| **Gas drain via plan change** | `OP_CHANGE_PLAN` requires `msg_value ≥ 0.05 TON` before forwarding |

Full threat model with 23 documented properties: [docs/SECURITY.md](docs/SECURITY.md)

---

## Documentation

| Document | Contents |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | 10-minute onboarding for service developers |
| [INTEGRATION.md](docs/INTEGRATION.md) | Subscribe message format, webhook events, status getters, subscriber actions (cancel/pause/top-up), React SDK |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Key generation, server setup, PM2, nginx, mainnet checklist |
| [SECURITY.md](docs/SECURITY.md) | Threat model and all 23 security properties |
| [PROTOCOL_FEE.md](docs/PROTOCOL_FEE.md) | Fee split mechanics, invariants, bounced fee recovery |
| [WHITEPAPER.md](docs/WHITEPAPER.md) | Protocol design decisions and architecture rationale |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | All tunable parameters and their defaults |
| [KEEPER.md](docs/KEEPER.md) | Keeper network: permissionless vs. relayer mode, rewards |
| [BYTECODE_HASHES.md](docs/BYTECODE_HASHES.md) | Published contract hashes for independent verification |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

---

## Build & Tests

```bash
npm install
npm test                       # 83 tests — security · integration · registry
ts-node scripts/test-e2e.ts    # E2E on testnet (requires .env with real keys)
```

---

## License

[Business Source License 1.1](LICENSE) — free for non-commercial use.  
Converts to MIT on **2029-05-15**.  
Commercial licensing: see [LICENSE](LICENSE) for contact details.

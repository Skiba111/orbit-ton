# Changelog

All notable changes to ORBIT are documented here.
Format: [Semantic Versioning](https://semver.org). Breaking changes are marked **BREAKING**.

---

## [0.1.1] — 2026-05-16

### Testnet E2E confirmed ✅

**E2E cycle verified on testnet:**
- Factory: `EQDYJOcdv9C_Uf3tNqCvgPuAQT-hVxLdOEfJePtSiR_YjVCS` (period=120s)
- Subscription: `EQAem3BPC7PvJzPGItrwNDVizMSqFIZ0nUDZvebfB4NBDn5w`
- 6 confirmed charges via relayer, all received by webhook

**Bug fixes discovered during E2E:**
- `scripts/relayer.ts`: TonCenter v2 API returns StateInit in `msg_data.init_state`, not `msg_data.init` — fixed detection logic
- `scripts/relayer.ts`: added `dotenv.config()` (was missing, causing `FACTORY_ADDRESS is not set` error on server restart)
- `scripts/webhook-server.ts`: added `dotenv.config()`
- `scripts/relayer.ts`: removed explicit `provider` arguments from `Subscription` getter calls (wrappers don't accept them)
- `scripts/relayer.ts`: moved `TonClient` import from `@ton/core` to `@ton/ton`
- `scripts/test-e2e.ts`: corrected subscribe body format:
  - `PAYMENT_TON = 1` (not 0 — 0 is invalid, causes assert failure in Factory)
  - Body must include `query_id (64 bits)` after `op` — Factory always reads it
- `scripts/deploy-standalone.ts`: added `domainSign` polyfill via `patch-ton-core.ts`
- `scripts/deploy-standalone.ts`: fixed `getSeqno()` to check `exit_code !== 0` before parsing stack

**New files:**
- `scripts/patch-ton-core.ts` — polyfill for `domainSign` missing in `@ton/core@0.56.x`
- `scripts/test-e2e.ts` — full E2E test script

**Updated docs:**
- README — testnet status, correct subscribe body format, real addresses
- DEPLOYMENT.md — replaced Blueprint references with `deploy-standalone.ts`, added VPS setup
- INTEGRATION.md — correct `payment_type` values, correct body format, no-arg getter calls
- CONFIGURATION.md — added `WEBHOOK_SECRET`, `INITIAL_SUBSCRIPTIONS` env vars

---

## [0.1.0] — 2026-05-14

### Initial release

**Contracts**
- `Subscription` — per-user billing contract with TON and Jetton payment support
- `Factory` — plan registry, deterministic subscription deployment, MRR analytics
- `FeeCollector` — protocol fee accumulator with 24-hour two-phase timelock withdrawal

**Billing features**
- Grace period (3 days) with retry before cancellation
- Fixed-term subscriptions (`max_periods`)
- Keeper network with dual-reward model (base from subscription + bonus from keeper pool)
- `OP_CHANGE_PLAN` — subscriber upgrades/downgrades via factory routing
- `OP_SET_MAX_PERIODS` — service sets fixed-term cap on existing subscription
- `OP_UPDATE_FEE_BPS` — service updates fee rate for new subscriptions only

**Security**
- Ed25519 signature verification on all external messages
- Seqno replay protection
- `charging_in_progress` double-charge guard for Jetton subscriptions
- Jetton wallet auto-learn + authentication on `OP_JETTON_EXCESSES`
- `raw_reserve` storage depletion guard on every send
- Bounce handler restoring deposit on failed payment messages
- 24-hour timelock on FeeCollector withdrawals

**React SDK** (`@orbit-ton/react` v0.1.0)
- `OrbitProvider`, `useSubscription`, `useSubscribe`, `useFactory` hooks
- `SubscribeButton`, `SubscriptionStatus`, `TopUpDeposit`, `KeeperPoolStatus` components
- `buildSubscribeCell` — correct bit-level body builder (Cell API, not Buffer)
- `PAYMENT_TON` / `PAYMENT_JETTON` constants
- `exports` field for tree-shaking

**Infrastructure**
- Charge relayer with WAL, exponential backoff, webhook notifications
- Blueprint wrappers for all contracts
- Security test suite (13 scenarios)
- Integration test suite (7 scenarios)
- GitHub Actions CI
- Docs: README, INTEGRATION, DEPLOYMENT, SECURITY, CONFIGURATION, WHITEPAPER

---

## [Unreleased]

- Mainnet deployment
- External security audit
- npm publish `@orbit-ton/react`
- Multi-service factory (single factory, multiple service addresses)

# Changelog

All notable changes to ORBIT are documented here.
Format: [Semantic Versioning](https://semver.org). Breaking changes are marked **BREAKING**.

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

- Testnet deployment
- External security audit
- npm publish `@orbit-ton/react`
- Multi-service factory (single factory, multiple service addresses)

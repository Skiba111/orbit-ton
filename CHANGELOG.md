# Changelog

All notable changes to ORBIT are documented here.
Format: [Semantic Versioning](https://semver.org). Breaking changes are marked **BREAKING**.

---

## [0.1.3] — 2026-05-17

### Mainnet deployment & operational scripts

**Mainnet live:** Registry, FeeCollector, and Factory deployed to TON mainnet. First subscriptions created and confirmed.

**New scripts:**
- `scripts/add-plan.ts` — sends `OP_ADD_PLAN` to a Factory (env vars: `PLAN_PRICE_TON`, `PLAN_PERIOD_DAYS`, `PLAN_TRIAL_DAYS`, `PLAN_NAME`; override period with `PLAN_PERIOD_SEC` for sub-day testing)
- `scripts/test-subscribe.ts` — sends `OP_SUBSCRIBE` to a Factory and waits for the Subscription contract to appear (uses Factory outgoing transactions — avoids TonCenter getter encoding issues)
- `scripts/cancel-subscription.ts` — sends `OP_CANCEL` from the subscriber wallet to recover the deposit

**Fee adjustment:**
- `PROTOCOL_FEE_BPS` changed from 20 (0.2%) to 150 (1.5%) — updated in `utils/protocol-config.tolk`
- `PLATFORM_FEE_BPS` default in `scripts/deploy-registry.ts` changed from 50 to 0 — service operators registered via Registry receive 0% platform fee on top of the 1.5% protocol fee

**Bug fixes:**
- `scripts/test-subscribe.ts`: `waitSubscription` now discovers new subscriptions via Factory outgoing transactions instead of the broken `get_subscription_address` TonCenter getter (TonCenter v2 returns 422 for that call due to stack encoding limitations)
- `scripts/add-plan.ts`: period calculation uses `Math.round(parseFloat(...) * 86400)` instead of `parseInt` — fixes zero period for fractional day inputs
- `tests/fee-collector.spec.ts`: removed `feeCollector as any` from all getter calls (SandboxContract auto-injects provider); replaced `.rejects.toThrow()` on post-accept VM failures with state side-effect checks

**Relayer: WAL stuck-entry fix**
- Added `WAL_MAX_ATTEMPTS = 10` and `WAL_MAX_AGE_S = 1800` (30 min) abandon thresholds
- WAL entries that exceed either limit are cleared and re-queued via the normal scan loop
- Fixes permanently stuck WAL entries caused by TonCenter HTTP 500 false negatives (the node had accepted the tx but TonCenter returned 500 — the WAL would never advance)
- Post-500 path now re-fetches subscription seqno to detect silent acceptance before retrying
- Backoff constants corrected: `BACKOFF_BASE_S = 30 s`, `BACKOFF_MAX_S = 3600 s (1 h)`

**Documentation:**
- All docs updated to reflect mainnet deployment
- `SECURITY.md`: property count corrected to 23
- `DEPLOYMENT.md`: Registry added to deployment table; `RELAYER_PUBKEY` added to env example; `deploy-registry.ts` vs `deploy-standalone.ts` distinction clarified
- `INTEGRATION.md`: added subscriber actions section (cancel, pause, top-up) with TonConnect examples and correct opcode values

---

## [0.1.2] — 2026-05-16

### Registry — platform entry point

**New contract: `contracts/registry.tolk`**

The Registry is a single on-chain entry point for service integration. A developer sends one transaction (0.3 TON) and receives a fully configured Factory with ORBIT fee settings enforced at the bytecode level — no manual deploy required.

Key properties:
- `platform_fee_bps` and `fee_collector` are copied into every Factory at deploy time and cannot be overridden by the service operator
- One Factory per sender — re-registration reverts with `ERROR_ALREADY_EXISTS`
- Owner-controlled: pause/resume registrations, update fee settings for future Factories, withdraw excess TON

**New files:**
- `contracts/registry.tolk` — Registry contract
- `utils/ops.tolk` — +9 opcodes `OP_REGISTRY_*` (0x4F520060–0x4F520068)
- `wrappers/Registry.ts` — TypeScript wrapper with all send/get methods
- `wrappers/registry.compile.ts` — compile helper
- `scripts/deploy-registry.ts` — deploys FeeCollector + Registry (ORBIT operator)
- `scripts/register-service.ts` — sends OP_REGISTRY_REGISTER (service developer)
- `tests/registry.spec.ts` — 33 tests covering all Registry operations

**Security fixes (also in this release):**

| Fix | File | Detail |
|-----|------|--------|
| **BREAKING** `OP_UPDATE_FEE_BPS` removed | `contracts/factory.tolk` | Handler deleted — `fee_bps` is now fully immutable after Factory deploy. Previously a service operator could call this to zero out the ORBIT fee after registering through Registry. |
| `keeper_wallet` addr_none guard | `contracts/subscription.tolk` | In keeper mode, `keeper_wallet` is now validated as a real address before `acceptExternalMessage()`. Prevents accidental or malicious sends to addr_none. |
| `fee_bps` cap in billing engine | `billing/fee-router.tolk` | `split_fee()` now asserts `fee_bps <= MAX_FEE_BPS` at charge time. Belt-and-suspenders guard alongside the plan-creation check. |
| Registry balance guard | `contracts/registry.tolk` | `OP_REGISTRY_REGISTER` now checks `my_balance >= REGISTRY_RESERVE + FACTORY_INIT_DEPOSIT` before sending the deploy message. |
| `OP_REGISTRY_UPDATE_PROTOCOL_COLLECTOR` added | `contracts/registry.tolk` | Owner can rotate `protocol_fee_collector` for future Factory deployments (0x4F520067). Existing Factories unaffected. |

**Bug fix in `wrappers/Registry.ts`:** added missing `getProtocolFeeCollector()` getter.

---

## [0.1.1] — 2026-05-16

### Testnet E2E confirmed ✅

**E2E cycle verified on testnet:**
- Test Factory deployed with period=120s, price=0.2 TON
- 6 confirmed charges triggered by relayer, all received by webhook
- Full cycle confirmed: subscribe → charge × 6 → webhook

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
- Gra
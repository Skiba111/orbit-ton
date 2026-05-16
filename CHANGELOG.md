# Changelog

All notable changes to ORBIT are documented here.
Format: [Semantic Versioning](https://semver.org). Breaking changes are marked **BREAKING**.

---

## [Unreleased] — fee update

### Fee adjustment

- `PROTOCOL_FEE_BPS` changed from 20 (0.2%) to 150 (1.5%) — updated in `utils/protocol-config.tolk`. All contract comments and documentation updated accordingly.
- `PLATFORM_FEE_BPS` default in `scripts/deploy-registry.ts` changed from 50 to 0. Service developers who register via Registry now receive a Factory with 0% platform fee (in addition to the 1.5% protocol fee baked into bytecode).

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
- `utils/ops.tolk` — +8 opcodes `OP_REGISTRY_*` (0x4F520060–0x4F520067)
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
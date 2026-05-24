# Configuration Reference

## Contract constants

### Subscription (`contracts/subscription.tolk` / `billing/`)

| Constant | Value | Description |
|---|---|---|
| `CHARGE_GAS_BUDGET` | 0.03 TON | Reserved in deposit for charge transaction gas |
| `KEEPER_REWARD` | 0.01 TON | Base reward per charge paid to a keeper |
| `DEFAULT_GRACE_SEC` | 259200 (3 days) | Grace period before subscription enters cancellation flow |
| `MAX_RETRY` | 5 | Max failed charge attempts before subscription is cancelled (within grace window) |
| `EXT_MSG_TTL` | 60 s | External message timestamp validity window |
| `CHARGE_TOLERANCE_SEC` | 120 s | How early a charge can arrive before `next_billing_time` |
| `MIN_PERIOD` | 3600 s (1 hour) | Minimum billing period |
| `MAX_PERIOD` | 315360000 s (10 years) | Maximum billing period |
| `MAX_FEE_BPS` | 1000 (10%) | Maximum service fee (`fee_bps`) |
| `STORAGE_RESERVE` | 0.05 TON | Minimum TON always kept for rent (compile-time constant in `core/storage-layout.tolk`) |

> **Cancellation trigger**: a subscription is cancelled when **either** the grace period expires (`DEFAULT_GRACE_SEC`) **or** the charge has failed `MAX_RETRY` times — whichever comes first.

### Factory (`contracts/factory.tolk`)

| Constant | Value | Description |
|---|---|---|
| `FACTORY_RESERVE` | 0.1 TON | Always kept in factory for rent |
| `FACTORY_DEPLOY_GAS` | 0.05 TON | Gas forwarded for subscription deployment and plan changes |
| `KEEPER_REWARD` | 0.01 TON | Shared constant (`utils/math-safe.tolk`); bonus from keeper_pool per charge (when pool funded) |

### FeeCollector (`contracts/fee-collector.tolk`)

| Constant | Value | Description |
|---|---|---|
| `COLLECTOR_RESERVE` | 0.1 TON | Always kept in collector for rent |
| `WITHDRAWAL_TIMELOCK_SEC` | 86400 s (24 hours) | Delay between schedule and execute |

## Fee configuration

Every billing cycle deducts **two fees** from the gross plan amount before sending the remainder to the service:

| Fee | Who sets it | Recipient | Default |
|-----|-------------|-----------|---------|
| Service fee (`fee_bps`) | Factory operator at deploy | `fee_collector` | configurable |
| Protocol fee | Hardcoded in bytecode (`PROTOCOL_FEE_BPS = 150`) | ORBIT `protocol_fee_collector` | 1.5% (fixed) |

**Net amount received by service** = `plan_price × (1 − fee_bps/10000 − 0.015)`

Example — 10 TON/month plan, service fee 0% (default):
- Protocol fee (1.5%): 0.15 TON → ORBIT FeeCollector
- Service fee (0%): 0.00 TON
- **Net to service**: 9.85 TON

> **Important for pricing**: set `plan_price` high enough to cover both fees and still deliver the desired net revenue.
> `plan_price = desired_net / (1 − service_fee_rate − 0.015)`

`fee_bps` is set at Factory deploy time and is immutable. It applies to every subscription deployed by that factory.

| fee_bps | Service fee % | Net to service (on 10 TON plan) |
|---------|--------------|----------------------------------|
| 0 | 0% | 9.85 TON |
| 10 | 0.1% | 9.84 TON |
| 100 | 1.0% | 9.75 TON |
| 1000 | 10.0% (max) | 8.85 TON |

Protocol fee is always 1.5% and is always collected in TON regardless of subscription payment type (TON or Jetton).

See [PROTOCOL_FEE.md](PROTOCOL_FEE.md) for the full fee model and verification guide.

## Plan fields

Each plan stored in the Factory has:

| Field | Type | Description |
|---|---|---|
| `price` | coins (TON) | Amount charged per billing period |
| `period` | uint32 (seconds) | Billing interval |
| `trial_period` | uint32 (seconds) | Free trial duration; 0 = no trial |
| `active` | bit | Whether new subscriptions can use this plan |
| `name_hash` | uint256 | sha256 of human-readable plan name (for display) |

## Deploy environment variables

Used by `scripts/deploy-registry.ts` and `scripts/deploy-standalone.ts`.

| Variable | Default | Description |
|---|---|---|
| `WALLET_MNEMONIC` | **(required)** | 24-word mnemonic of the deployer wallet |
| `FEE_COLLECTOR_PUBKEY` | **(required)** | Hex Ed25519 pubkey for FeeCollector cold key |
| `RELAYER_PUBKEY` | **(required for Registry deploy)** | Hex Ed25519 pubkey of the ORBIT relayer |
| `TONCENTER_API_KEY` | (empty) | TonCenter API key (recommended) |
| `NETWORK` | `testnet` | `mainnet` or `testnet` |
| `WALLET_VERSION` | `v5` | `v4` or `v5` (v5 = Tonkeeper / TG Wallet) |
| `PLATFORM_FEE_BPS` | `0` | Additional platform fee baked into Registry-deployed Factories (0 = no extra fee; protocol fee 1.5% always applies regardless) |

## Service registration environment variables

Used by `scripts/register-service.ts` (called by service operators, not ORBIT).

| Variable | Default | Description |
|---|---|---|
| `WALLET_MNEMONIC` | **(required)** | 24-word mnemonic of the service operator wallet |
| `REGISTRY_ADDRESS` | **(required)** | ORBIT Registry contract address |
| `NETWORK` | `testnet` | `mainnet` or `testnet` |
| `WALLET_VERSION` | `v5` | `v4` or `v5` |
| `TONCENTER_API_KEY` | (empty) | TonCenter API key (recommended) |

## Relayer environment variables

| Variable | Default | Description |
|---|---|---|
| `FACTORY_ADDRESS` | **(required)** | Factory contract address |
| `RELAYER_MNEMONIC` | **(required)** | Space-separated Ed25519 mnemonic (relayer key) |
| `NETWORK` | `testnet` | `mainnet` or `testnet` |
| `POLL_INTERVAL_MS` | `60000` | Polling interval in ms |
| `DB_PATH` | `data/subscriptions.json` | Local subscription index |
| `WAL_PATH` | `data/relayer-wal.json` | Write-ahead log (charge intent journal) |
| `WEBHOOK_URL` | (empty) | POST endpoint called after each confirmed charge |
| `WEBHOOK_SECRET` | (empty) | Shared HMAC-SHA256 signing key. Every delivery includes `X-Orbit-Signature: sha256=<hex>`. Verify with `timingSafeEqual`. |
| `INITIAL_SUBSCRIPTIONS` | (empty) | Comma-separated subscription addresses to seed on first run |
| `TONCENTER_API_KEY` | (empty) | TonCenter API key (recommended — raises rate limits) |

## Relayer hardcoded constants

These are compile-time constants in `scripts/relayer.ts` — not configurable via env vars.

| Constant | Value | Description |
|---|---|---|
| `CHARGE_LEAD_S` | 120 s | Relayer attempts a charge up to 120 s before `next_billing_time`. Matches `CHARGE_TOLERANCE_SEC` in the contract. |
| `WAL_MAX_ATTEMPTS` | 10 | WAL entry is abandoned after this many retry attempts |
| `WAL_MAX_AGE_S` | 1800 s (30 min) | WAL entry is abandoned if it has been retrying for more than 30 minutes |
| `BACKOFF_BASE_S` | 30 s | Initial retry delay after a failed charge: 30 s → 60 s → 120 s → … |
| `BACKOFF_MAX_S` | 3600 s (60 min) | Maximum backoff delay between retries |

After abandonment the WAL entry is cleared and the main scan loop will re-attempt the charge on the next poll cycle.

## Two webhook delivery channels

ORBIT provides two independent webhook systems. They serve different purposes and can be used together or separately.

| Channel | Event names | Retry | Auth | Configured via |
|---------|-------------|-------|------|----------------|
| **Relayer direct** | `charge.success` (seqno-based) | None — fire and forget | `X-Orbit-Signature: sha256=<hmac>` | `WEBHOOK_URL` + `WEBHOOK_SECRET` env vars in relayer |
| **Backend webhooks** | `charge.success`, `charge.failed`, `subscription.activated`, `subscription.cancelled`, `subscription.grace`, `subscription.recovered` | Yes — up to 5 retries with exponential backoff (30s → 2m → 8m → 32m → 2h) | Same HMAC-SHA256 scheme | `POST /api/v1/services/:id/webhooks` in Dashboard or via API |

**Recommendation:** Use **backend webhooks** for production integrations — they have retry logic, delivery logs, and cover all lifecycle events. Use the **relayer direct** webhook only for lightweight scripts or debugging.

## Webhook payload

When `WEBHOOK_URL` is set, the relayer posts the following JSON body after each confirmed charge:

```json
{
  "event":      "charge.success",
  "address":    "EQD...",
  "seqno_from": 4,
  "seqno_to":   5,
  "timestamp":  1718000000
}
```

The `X-Orbit-Signature: sha256=<hmac>` header is included when `WEBHOOK_SECRET` is set.
Verify it with `timingSafeEqual` before trusting the payload (see [INTEGRATION.md](INTEGRATION.md)).

Use this to update access control in your backend: mark the subscription as active and provision the subscriber's service tier.

## Payment types

| Code | Constant | Description |
|---|---|---|
| 1 | `PAYMENT_TON` | Subscription charged in TON |
| 2 | `PAYMENT_JETTON` | Subscription charged in Jetton tokens |

> **Important:** `payment_type = 0` is **invalid** — the Factory contract asserts `payment_type == 1 or 2`. Sending `0` will cause the transaction to bounce immediately.

## Status codes

| Code | Constant | Description |
|---|---|---|
| 1 | `STATUS_TRIAL` | Active trial period, no charge yet |
| 2 | `STATUS_ACTIVE` | Paid and current |
| 3 | `STATUS_PAUSED` | Service or subscriber paused billing |
| 4 | `STATUS_GRACE` | Insufficient deposit; charge overdue |
| 5 | `STATUS_CANCELLED` | Subscription ended; deposit refunded |

## Error codes

| Code | Name | When thrown |
|---|---|---|
| 401 | `ERROR_UNAUTHORIZED` | Wrong sender for access-controlled op |
| 402 | `ERROR_INSUFFICIENT_FUNDS` | Deposit or balance too low |
| 403 | `ERROR_WRONG_SENDER` | Message from unexpected contract |
| 404 | `ERROR_NOT_FOUND` | Plan or subscriber not in dict |
| 406 | `ERROR_NO_PENDING_WITHDRAWAL` | OP_CONFIRM_COLLECT without prior OP_COLLECT |
| 409 | `ERROR_INVALID_STATE` | Op not allowed in current status |
| 410 | `ERROR_PLAN_INACTIVE` | Subscribe attempt to deactivated plan |
| 412 | `ERROR_ALREADY_EXISTS` | Duplicate operation |
| 415 | `ERROR_INVALID_PLAN` | Plan ID out of range |
| 416 | `ERROR_INVALID_AMOUNT` | Price = 0 or exceeds MAX_COINS; also thrown when `fee_bps > MAX_FEE_BPS` (1000) |
| 422 | `ERROR_INVALID_PERIOD` | Period outside [MIN_PERIOD, MAX_PERIOD] |
| 423 | `ERROR_ALREADY_CHARGING` | Jetton charge in progress |
| 424 | `ERROR_INVALID_SEQNO` | External message seqno mismatch |
| 425 | `ERROR_TOO_EARLY` | Charge before next_billing_time |
| 426 | `ERROR_TRIAL_USED` | Subscriber already used trial |
| 427 | `ERROR_REPLAY` | Duplicate message detected |
| 428 | `ERROR_SIGNATURE` | Invalid Ed25519 signature |
| 429 | `ERROR_MSG_EXPIRED` | External message timestamp too old |
| 430 | `ERROR_TIMELOCK_ACTIVE` | OP_CONFIRM_COLLECT before 24h elapsed |
| 500 | `ERROR_OVERFLOW` | Arithmetic overflow in safe_add/safe_sub |
| 503 | `ERROR_PAUSED` | Factory or subscription is paused |
| 504 | `ERROR_JETTON_PENDING` | Jetton charge in flight |
| 507 | `ERROR_STORAGE_RESERVE` | Cannot send — would breach storage reserve |
| 65535 | `ERROR_INVALID_OP` | Unknown operation code |
                          
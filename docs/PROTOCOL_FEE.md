# Protocol Fee Model

## Overview

Every ORBIT billing cycle deducts two fees from the gross plan amount before sending the remainder to the service:

| Fee | Rate | Who sets it | Recipient | Changeable? |
|-----|------|-------------|-----------|-------------|
| **Protocol fee** | 1.5% (hardcoded) | ORBIT team — baked into bytecode | ORBIT `FeeCollector` | No — immutable in every deployed contract |
| **Service fee** | 0–10% (`fee_bps`) | Factory deployer at deploy time | Service `fee_collector` | No — immutable per factory after deploy |

**Net received by service** = `plan_price × (1 − fee_bps/10000 − 0.015)`

### Example — 1 TON/month plan, service fee 1% (100 bps)

| Flow | Amount | Destination |
|------|--------|-------------|
| Gross | 1.000 TON | — |
| Protocol fee (1.5%) | 0.015 TON | ORBIT `FeeCollector` |
| Service fee (1%) | 0.010 TON | Service `fee_collector` |
| **Net to service** | **0.975 TON** | `service_addr` |

### Pricing formula

To deliver a target net amount to the service:

```
plan_price = desired_net / (1 − service_fee_rate − 0.015)
```

Example: to net 1 TON with 1% service fee → `plan_price = 1 / (1 − 0.01 − 0.015) ≈ 1.017 TON`

---

## Protocol fee implementation

`PROTOCOL_FEE_BPS = 150` is a compile-time constant in `utils/protocol-config.tolk`. It is compiled into every Subscription contract's bytecode. There is no storage slot, no setter, and no admin function that can alter it at runtime.

Every deployed Subscription carries a code hash. Any contract not matching the official ORBIT hash published in [BYTECODE_HASHES.md](BYTECODE_HASHES.md) is immediately identifiable on-chain by any subscriber or indexer.

### Verifying the bytecode hash

Subscribers can verify their Subscription contract uses official ORBIT code by comparing the on-chain code hash against the published hash in the ORBIT repository. Any ORBIT explorer or TON indexer can fetch the code cell hash for a given contract address.

---

## Protocol fee collector address

`PROTOCOL_FEE_COLLECTOR_HASH` in `utils/protocol-config.tolk` is a **reference-only constant** — it is not called at runtime and does not affect fee routing in any deployed contract. All fees go to the `protocol_fee_collector` address stored in the Factory's state, which is set when the Factory is deployed and propagated to each Subscription at subscribe time.

The ORBIT team can rotate this address using two paths:

1. **Per-Factory rotation** — send `OP_UPDATE_PROTOCOL_COLLECTOR` directly to a Factory. Only the current `protocol_fee_collector` wallet can issue this (not the factory owner). The new address applies to all future Subscription deployments from that Factory. Existing deployed Subscriptions continue sending to their original stored address.

2. **Registry-level rotation** — send `OP_REGISTRY_UPDATE_PROTOCOL_COLLECTOR` to the Registry (owner-authenticated). This updates the address for all **future** Factory deployments via the Registry. Existing deployed Factories and their Subscriptions are unaffected.

---

## FeeCollector withdrawal

Protocol fees accumulate in the `FeeCollector` contract. Withdrawal is protected by a 24-hour two-phase timelock:

1. **`OP_COLLECT`** — owner schedules a withdrawal; amount and destination are stored.
2. **`OP_CONFIRM_COLLECT`** — after 24 hours, owner executes the withdrawal.

If the owner key is compromised, the timelock window allows rotating the key and cancelling the pending withdrawal before funds move.

---

## Service fee (`fee_bps`) reference table

Protocol fee is always **1.5%** (0.015 TON on a 1 TON plan).  
Net = `plan_price − protocol_fee(1.5%) − service_fee(fee_bps)`

| `fee_bps` | Service fee % | Net to service (on 1 TON plan) |
|-----------|--------------|--------------------------------|
| 0 | 0% | 0.985 TON |
| 10 | 0.1% | 0.984 TON |
| 100 | 1.0% | 0.975 TON |
| 500 | 5.0% | 0.935 TON |
| 1000 | 10.0% (max) | 0.885 TON |

`fee_bps` is validated against `MAX_FEE_BPS = 1000` at deploy time. Values above 10% are rejected by the Factory.

---

## Jetton subscriptions

For Jetton subscriptions (e.g. USDT), the plan price is paid in Jetton tokens.

> **⚠️ Known limitation (current version):** For Jetton subscriptions, both the service fee (`fee_bps`) and the protocol fee are computed using `bps_of(amount, bps)` where `amount` is the Jetton token unit count. The resulting integer is then sent as nanoton. For typical Jetton amounts (e.g. 1 USDT = 1 000 000 micro-USDT) this produces near-zero fees in TON. **ORBIT currently uses `PLATFORM_FEE_BPS = 0` for Jetton deployments. Do not launch Jetton plans with `fee_bps > 0` until a dedicated Jetton fee model is implemented.**

For TON subscriptions, the protocol fee is collected in nanoton from the plan amount — this is the fully supported and recommended path for any deployment where fee economics matter.

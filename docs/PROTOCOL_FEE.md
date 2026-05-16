# Protocol Fee Model

## Overview

Every ORBIT billing cycle deducts two fees from the gross plan amount before sending the remainder to the service:

| Fee | Rate | Who sets it | Recipient | Changeable? |
|-----|------|-------------|-----------|-------------|
| **Protocol fee** | 1.5% (hardcoded) | ORBIT team — baked into bytecode | ORBIT `FeeCollector` | No — changing it requires recompiling with a different hash |
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

A service that wants to avoid the protocol fee must compile its own Subscription bytecode — the resulting code hash will differ from the published ORBIT hash, making it immediately detectable on-chain.

### Verifying the bytecode hash

Subscribers can verify their Subscription contract uses official ORBIT code by comparing the on-chain code hash against the published hash in the ORBIT repository. Any ORBIT explorer or TON indexer can fetch the code cell hash for a given contract address.

---

## Protocol fee collector address

`PROTOCOL_FEE_COLLECTOR_HASH` is also a compile-time constant. All fees for subscriptions deployed from a given Factory go to the `protocol_fee_collector` address stored in that Factory's state at the time the Subscription was deployed.

The ORBIT team can rotate this address for **new** subscriptions via `OP_UPDATE_PROTOCOL_COLLECTOR`. Only the current `protocol_fee_collector` wallet can issue this operation — not the factory owner. Existing deployed subscriptions continue sending to their original stored address and are unaffected by the rotation.

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

For Jetton subscriptions (e.g. USDT), the plan price is paid in Jetton tokens. The **protocol fee is always collected in TON** — it is taken from the TON value attached to the charge message, not from the Jetton amount. This keeps the `FeeCollector` single-asset and ensures the protocol always receives spendable TON regardless of which Jetton is used.

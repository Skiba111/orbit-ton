# Security Model

## What ORBIT protects

### 1. Double-charge guard
`charging_in_progress` flag is set before any Jetton transfer and cleared only when `OP_JETTON_EXCESSES` arrives from the known Jetton wallet. While set, no new charge can start.

### 2. Replay protection
Every state-changing operation increments `seqno`. External messages must include the current seqno; stale messages are rejected.

### 3. Rate limiting
`next_billing_time` is checked before every charge. Charges earlier than `next_billing_time - CHARGE_TOLERANCE_SEC` are rejected. A misbehaving relayer cannot double-charge within a billing period.

### 4. Storage reserve
`raw_reserve(storage_reserve, 0)` is called before every send. The contract always retains enough TON to pay for its own storage rent.

### 5. Jetton atomicity
The `charging_in_progress` flag prevents a second charge from starting before the first Jetton transfer is confirmed. The flag is only cleared by an authenticated `OP_JETTON_EXCESSES` from the known Jetton wallet address.

### 6. Plan snapshot
Amount and period are locked into the Subscription at deploy time. Factory plan changes don't retroactively alter existing subscriptions without an explicit `OP_APPLY_PLAN` from the factory.

### 7. Bounce handler
If a payment message bounces (e.g. frozen service contract), `on_charge_bounced` restores the deducted deposit and rolls back the billing time. Subscribers are not silently drained by a broken service.

### 8. Gas budget check
`has_funds_for_charge` requires `deposit >= amount + storage_reserve + CHARGE_GAS_BUDGET`. This prevents charges that would leave the contract without gas for future operations.

### 9. Fee routing integrity
`fee_collector` address is immutable after deploy. No operation can redirect protocol fees to a different address.

### 10. Charge notification authentication
`OP_CHARGE_NOTIFICATION` carries the `subscriber_addr` field. The factory verifies that the sender matches the `sub_addr` stored in `subscriber_info` for that subscriber — preventing anyone from spoofing this message to drain the keeper pool.

### 11. FeeCollector timelock
A 24-hour delay between scheduling (`OP_COLLECT`) and executing (`OP_CONFIRM_COLLECT`) a withdrawal gives time to detect a compromised owner key and rotate it before funds move.

### 12. OP_CHANGE_PLAN spoofing prevention
`OP_CHANGE_PLAN` messages from subscribers reach the Factory. The Factory looks up the subscriber's subscription address from its own `subscriber_info` dict — the address is NOT provided by the caller. This prevents an attacker from targeting another user's subscription.

### 13. Jetton wallet authentication
`OP_JETTON_EXCESSES` and `OP_JETTON_TRANSFER_NOTIFICATION` are only accepted from the known `jetton_wallet` address. On first notification the address is auto-learned; all subsequent ones must match.

### 14. Keeper mode is intentionally permissionless
In `keeper_mode = 1`, any external actor can trigger a charge by sending a valid external message with the current seqno, a fresh timestamp, and their wallet address. This is by design — it creates an open market for charge execution. The subscriber is charged exactly what the plan specifies; only the keeper reward routing changes. The `keeper_wallet` address in the message controls where the 0.01 TON base reward is sent. If this permissionless model is undesirable, disable keeper mode and use only the relayer (`keeper_mode = 0`).

### 15. Protocol fee is hardcoded in bytecode — cannot be bypassed

`PROTOCOL_FEE_BPS = 20` (0.2%) and `PROTOCOL_FEE_COLLECTOR_HASH` are constants compiled into the Subscription contract bytecode. No `save_storage` call, no factory configuration, no operator action can change them without recompiling from source.

A service wishing to avoid the protocol fee would have to distribute modified bytecode. That bytecode would have a different hash, making it trivially detectable as non-official ORBIT. Subscribers can verify the code hash of their Subscription contract on-chain against the published ORBIT bytecode hash.

The protocol fee collector address can be rotated per-factory via `OP_UPDATE_PROTOCOL_COLLECTOR` (restricted to the current `protocol_fee_collector` address — not the service owner). This allows the ORBIT team to redirect fees to a new wallet. Existing subscriptions are unaffected; only new subscriptions deployed after the update use the new address.

See [PROTOCOL_FEE.md](PROTOCOL_FEE.md) for the full model.

## What ORBIT does NOT protect

- **Service contract behaviour** — ORBIT sends payment but cannot verify the service delivers the promised product.
- **Relayer liveness** — If the relayer goes down, charges don't happen. Use keeper mode to allow external keepers to trigger charges.
- **TON price volatility** — TON-denominated subscriptions have price risk. Use Jetton (e.g. USDT) plans to stabilise pricing.
- **Factory owner key compromise** — The service owner key can add/remove plans, pause/resume the factory, and withdraw gas reserves. It cannot steal subscriber deposits. Rotate keys if compromised.
- **Relayer key compromise** — A compromised relayer key can trigger charges earlier than scheduled (within `CHARGE_TOLERANCE_SEC`) but cannot steal funds or modify state beyond what a legitimate charge would do.
- **FeeCollector owner key compromise** — A compromised key can schedule a withdrawal but cannot execute it for 24 hours. Rotate the key within the timelock window to cancel any pending withdrawal.

## Known limitations

- No on-chain price oracle: service owner sets plan prices; there is no automatic USD-pegged billing.
- Single relayer key per factory: all subscriptions in a factory share one relayer key. Key rotation (`OP_ROTATE_RELAYER`) requires a separate transaction per subscription.
- MRR counters (`total_charges`, `total_revenue`) are only updated via authenticated `OP_CHARGE_NOTIFICATION`. For auditing, cross-check on-chain events against the counter values.

## Audit status

Not yet externally audited. See the roadmap for planned audit timeline.

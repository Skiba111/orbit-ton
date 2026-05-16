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

`keeper_wallet` is validated as a non-null address (`!is_addr_none`) before `acceptExternalMessage()` is called. This prevents an external message with a zero address from causing the keeper reward to be sent to an invalid destination.

### 16. `fee_bps` is immutable after Factory deploy — no backdoor

`fee_bps` is stored in Factory state at deploy time and cannot be changed afterwards. The `OP_UPDATE_FEE_BPS` handler was removed (it previously allowed the service owner to zero out ORBIT's platform fee after registering through the Registry). Additionally, `split_fee()` in the billing engine asserts `fee_bps <= MAX_FEE_BPS` at charge time as a belt-and-suspenders guard.

### 17. Registry enforces fee settings at the protocol level
Service operators who register through the Registry receive a Factory with `fee_bps` and `fee_collector` baked in from Registry state. These values are copied into the Factory's immutable storage at deploy time — the service cannot change them after registration. This makes the ORBIT fee model trustless: the fee is set by the ORBIT operator and cannot be bypassed by any action of the service operator.

### 18. Jetton deposit isolation — empty-body TON does not inflate token balance

For Jetton subscriptions, the `deposit` field tracks the **Jetton token count**, not TON nanotons. The plain-TON (empty-body) message handler only updates `deposit` when `payment_type == PAYMENT_TON`. For Jetton subscriptions, incoming TON is accepted (goes to the contract balance for gas/rent) but `deposit` remains unchanged.

Without this guard, anyone could send TON with an empty body to inflate the apparent token balance, bypass `has_funds_for_charge`, trigger a Jetton transfer with no actual tokens, receive an unhandled bounce, and leave `charging_in_progress = 1` permanently — permanently disabling the subscription (griefing attack).

### 19. `OP_CHANGE_PLAN` minimum gas guard — Factory drain prevention

`OP_CHANGE_PLAN` in the Factory forwards `FACTORY_DEPLOY_GAS` (0.05 TON) to the subscription via `OP_APPLY_PLAN`. Without a minimum `msg_value` guard, a subscriber could send near-zero-value plan-change messages and gradually drain the Factory's balance. The guard `assert(msg_value >= FACTORY_DEPLOY_GAS)` ensures the subscriber covers the forwarding cost.

### 15. Protocol fee is hardcoded in bytecode — cannot be bypassed

`PROTOCOL_FEE_BPS = 150` (1.5%) and `PROTOCOL_FEE_COLLECTOR_HASH` are constants compiled into the Subscription contract bytecode. No `save_storage` call, no factory configuration, no operator action can change them without recompiling from source.

A service 
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

### 10. Charge notification is read-only
`OP_CHARGE_NOTIFICATION` only increments analytics counters. No auth required because there are no funds at risk — an attacker can spam fake notifications but cannot steal anything.

### 11. FeeCollector timelock
A 24-hour delay between scheduling (`OP_COLLECT`) and executing (`OP_CONFIRM_COLLECT`) a withdrawal gives time to detect a compromised owner key and rotate it before funds move.

### 12. OP_CHANGE_PLAN spoofing prevention
`OP_CHANGE_PLAN` messages from subscribers reach the Factory. The Factory looks up the subscriber's subscription address from its own `subscriber_info` dict — the address is NOT provided by the caller. This prevents an attacker from targeting another user's subscription.

### 13. Jetton wallet authentication
`OP_JETTON_EXCESSES` and `OP_JETTON_TRANSFER_NOTIFICATION` are only accepted from the known `jetton_wallet` address. On first notification the address is auto-learned; all subsequent ones must match.

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
- `OP_CHARGE_NOTIFICATION` is unauthenticated: MRR counters can be inflated by spamming fake notifications. Use on-chain event filtering for accurate revenue reporting.

## Audit status

Not yet externally audited. See the roadmap for planned audit timeline.

// Charge engine — the heart of ORBIT.
//
// Security properties guaranteed here:
//
//  1. Double-charge guard   charging_in_progress flag; set before, cleared after
//  2. Rate limiting         next_billing_time check with CHARGE_TOLERANCE_SEC
//  3. Replay protection     seqno monotonicity (enforced by role-manager)
//  4. Storage protection    reserveToncoinsOnBalance(STORAGE_RESERVE) before every send
//  5. Jetton atomicity      charging_in_progress=1 until OP_JETTON_EXCESSES arrives
//  6. Plan snapshot         amount/period locked at subscribe time (no bait-switch)
//  7. Bounce handler        on_bounce restores state if downstream fails
//  8. Gas budget check      deposit must cover amount + storage_reserve + CHARGE_GAS_BUDGET
//  9. Fixed-term guard      if max_periods > 0 and periods_charged >= max_periods, cancel
// 10. Charge notification   subscription notifies factory after each success for MRR stats
//
// Protocol fee (fee_bps) is ALWAYS charged in TON, regardless of payment_type.
// For Jetton subscriptions the subscriber must maintain enough TON in their
// deposit to cover (storage_reserve + CHARGE_GAS_BUDGET + fee_per_cycle).
// The Jetton amount covers the service payment; TON covers gas and protocol fee.

import "../utils/errors.tolk"
import "../utils/math-safe.tolk"
import "../utils/ops.tolk"
import "../utils/time-oracle.tolk"
import "../core/subscription-state.tolk"
import "../core/period-math.tolk"
import "../core/storage-layout.tolk"
import "../billing/fee-router.tolk"
import "../billing/retry-scheduler.tolk"
import "../payment/ton-adapter.tolk"
import "../payment/jetton-adapter.tolk"

// ── Charge notification ───────────────────────────────────────────────────────
//
// Sent to the factory after a successful charge so it can update MRR counters
// and, when keeper_mode is active, dispatch a bonus reward from the keeper pool.
// Non-bounceable; failure of this message must NOT block the charge.
//
// subscriber_addr is included so the factory can authenticate the sender:
//   hash(subscriber_addr) → stored sub_addr → verify sender == stored sub_addr.
// This prevents anyone from spoofing OP_CHARGE_NOTIFICATION to drain keeper_pool.
fun send_charge_notification(
    factory_addr:   slice,
    plan_id:        int,
    amount:         int,
    subscriber_addr: slice,
    keeper_mode:    int,
    keeper_wallet:  slice
) {
    var body_builder = beginCell()
        .storeUint(OP_CHARGE_NOTIFICATION, 32)
        .storeUint(0, 64)
        .storeUint(plan_id, 32)
        .storeCoins(amount)
        .storeSlice(subscriber_addr)  // for factory sender authentication
        .storeUint(keeper_mode, 1); // has_keeper flag

    var body: cell = (keeper_mode == 1)
        ? body_builder.storeSlice(keeper_wallet).endCell()
        : body_builder.endCell();
    var msg: cell = beginCell()
        .storeUint(0x10, 6)       // non-bounceable
        .storeSlice(factory_addr)
        .storeCoins(FEE_MSG_GAS)  // minimal gas for notification
        .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .storeRef(body)
    .endCell();
    sendRawMessage(msg, 0); // mode 0 = pay from contract balance
}

// ── Keeper reward ─────────────────────────────────────────────────────────────

fun send_keeper_reward(keeper_wallet: slice) {
    var msg: cell = beginCell()
        .storeUint(0x10, 6)       // non-bounceable
        .storeSlice(keeper_wallet)
        .storeCoins(KEEPER_REWARD)
        .storeUint(0, 107)
    .endCell();
    sendRawMessage(msg, 0);
}

// ── Main charge entry-point ───────────────────────────────────────────────────
//
// Called from recv_external in subscription.tolk after all pre-accept guards.
// keeper_wallet is non-null only when keeper_mode == 1.
fun execute_charge(
    seqno:                  int,
    status:                 int,
    payment_type:           int,
    charging_in_progress:   int,
    paused_global:          int,
    keeper_mode:            int,
    retry_count:            int,
    period:                 int,
    next_billing_time:      int,
    grace_end_time:         int,
    plan_id:                int,
    max_periods:            int,
    periods_charged:        int,
    amount:                 int,
    deposit:                int,
    storage_reserve:        int,
    fee_bps:                int,
    trial_period:           int,
    service_addr:           slice,
    subscriber_addr:        slice,
    factory_addr:           slice,
    fee_collector:          slice,
    jetton_wallet:          slice,
    relayer_pubkey:         int,
    protocol_fee_collector: slice,  // ORBIT protocol address — set at deploy, cannot be bypassed
    keeper_wallet:          slice   // addr_none when keeper_mode == 0
) {
    assert(!(charging_in_progress == 1), ERROR_ALREADY_CHARGING);
    require_chargeable(status);
    assert(is_billing_due(next_billing_time), ERROR_TOO_EARLY);

    // Fixed-term subscription: cancel cleanly when all periods consumed.
    if ((max_periods > 0) & (periods_charged >= max_periods)) {
        save_storage(
            seqno + 1, STATUS_CANCELLED, payment_type,
            0, paused_global, keeper_mode,
            retry_count, period, next_billing_time,
            0, plan_id, max_periods, periods_charged,
            amount, 0, storage_reserve,
            fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr,
            fee_collector, jetton_wallet, relayer_pubkey, protocol_fee_collector
        );
        send_refund(subscriber_addr, deposit, storage_reserve);
        return;
    }

    // Grace expiry check — cancel without charge
    if (status == STATUS_GRACE) {
        if (grace_expired(grace_end_time)) {
            save_storage(
                seqno + 1, STATUS_CANCELLED, payment_type,
                0, paused_global, keeper_mode,
                retry_count, period, next_billing_time,
                0, plan_id, max_periods, periods_charged,
                amount, deposit, storage_reserve,
                fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr,
                fee_collector, jetton_wallet, relayer_pubkey, protocol_fee_collector
            );
            send_refund(subscriber_addr, deposit, storage_reserve);
            return;
        }
    }

    // Insufficient deposit — enter or extend grace, or cancel
    if (!has_funds_for_charge(deposit, amount, storage_reserve)) {
        var (new_status, new_retry, new_grace) = on_charge_failed(
            retry_count, grace_end_time, DEFAULT_GRACE_SEC
        );
        if (new_status == STATUS_CANCELLED) {
            save_storage(
                seqno + 1, STATUS_CANCELLED, payment_type,
                0, paused_global, keeper_mode,
                new_retry, period, next_billing_time,
                0, plan_id, max_periods, periods_charged,
                amount, deposit, storage_reserve,
                fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr,
                fee_collector, jetton_wallet, relayer_pubkey, protocol_fee_collector
            );
            send_refund(subscriber_addr, deposit, storage_reserve);
        } else {
            save_storage(
                seqno + 1, new_status, payment_type,
                0, paused_global, keeper_mode,
                new_retry, period, next_billing_time,
                new_grace, plan_id, max_periods, periods_charged,
                amount, deposit, storage_reserve,
                fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr,
                fee_collector, jetton_wallet, relayer_pubkey, protocol_fee_collector
            );
        }
        return;
    }

    // ── All checks passed — execute billing ───────────────────────────────────

    var new_deposit:     int = safe_sub(deposit, amount);
    var (net_amount, fee_amount, protocol_fee) = split_fee(amount, fee_bps);
    var new_next_billing: int = advance_billing(next_billing_time, period);
    var new_periods_charged: int = periods_charged + 1;

    var new_status: int = STATUS_ACTIVE;
    var new_retry:  int = 0;
    var new_grace:  int = 0;
    if (status == STATUS_GRACE) {
        var (s, r, g) = on_charge_succeeded_after_grace();
        new_status = s; new_retry = r; new_grace = g;
    }

    // Reserve rent before any sends (storage depletion guard)
    reserveToncoinsOnBalance(storage_reserve, 0);

    if (payment_type == PAYMENT_TON) {
        // TON: fire-and-forget → clear charging flag immediately.
        save_storage(
            seqno + 1, new_status, payment_type,
            0, paused_global, keeper_mode,
            new_retry, period, new_next_billing,
            new_grace, plan_id, max_periods, new_periods_charged,
            amount, new_deposit, storage_reserve,
            fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr,
            fee_collector, jetton_wallet, relayer_pubkey, protocol_fee_collector
        );
        send_payment_ton(service_addr, net_amount, subscriber_addr, plan_id);
    } else {
        // JETTON: charging_in_progress=1 until OP_JETTON_EXCESSES arrives.
        save_storage(
            seqno + 1, new_status, payment_type,
            1, paused_global, keeper_mode,
            new_retry, period, new_next_billing,
            new_grace, plan_id, max_periods, new_periods_charged,
            amount, new_deposit, storage_reserve,
            fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr,
            fee_collector, jetton_wallet, relayer_pubkey, protocol_fee_collector
        );
        var my_addr: slice = contract.getAddress() as slice;
        send_jetton_payment(
            my_addr, jetton_wallet, service_addr,
            net_amount, subscriber_addr, plan_id, seqno + 1
        );
    }

    // Service fee (configurable per-factory) and ORBIT protocol fee (hardcoded 0.2%).
    send_fee(fee_collector, fee_amount, subscriber_addr, plan_id);
    send_protocol_fee(protocol_fee_collector, protocol_fee, subscriber_addr, plan_id);

    // Notify factory: update MRR counters.
    // If keeper_mode=1, factory also sends KEEPER_REWARD from keeper_pool (bonus tier).
    // This is intentional two-tier design: subscription pays base reward unconditionally
    // so keepers are always compensated; factory pool pays a bonus when funded.
    // Total per-charge keeper payout = KEEPER_REWARD * 2 when keeper_pool >= KEEPER_REWARD.
    send_charge_notification(factory_addr, plan_id, amount, subscriber_addr, keeper_mode, keeper_wallet);

    // Base keeper reward — paid from subscription deposit, guaranteed regardless of pool state.
    if (keeper_mode == 1) {
        send_keeper_reward(keeper_wallet);
    }
}

// ── Bounce handler ────────────────────────────────────────────────────────────
//
// Called when a payment message bounces back (e.g. frozen service contract).
// Restores the deducted deposit so the subscriber isn't silently drained.
fun on_charge_bounced(
    seqno: int, status: int, payment_type: int,
    charging_in_progress: int, paused_global: int, keeper_mode: int,
    retry_count: int, period: int,
    next_billing_time: int, grace_end_time: int, plan_id: int,
    max_periods: int, periods_charged: int,
    amount: int, deposit: int, storage_reserve: int,
    fee_bps: int, trial_period: int,
    service_addr: slice, subscriber_addr: slice, factory_addr: slice,
    fee_collector: slice, jetton_wallet: slice,
    relayer_pubkey: int, protocol_fee_collector: slice
) {
    var restored_deposit: int = safe_add(deposit, amount);
    // Roll billing time back one period so the next relayer call will retry
    var prev_billing: int = safe_sub(next_billing_time, period);
    // Also roll back periods_charged since this charge did not land
    var prev_periods: int = (periods_charged > 0) ? (periods_charged - 1) : 0;
    var (new_status, new_retry, new_grace) = on_charge_failed(
        retry_count, grace_end_time, DEFAULT_GRACE_SEC
    );

    save_storage(
        seqno, new_status, payment_type,
        0, paused_global, keeper_mode,
        new_retry, period, prev_billing,
        new_grace, plan_id, max_periods, prev_periods,
        amount, restored_deposit, storage_reserve,
        fee_bps, trial_period,
        service_addr, subscriber_addr, factory_addr,
        fee_collector, jetton_wallet, relayer_pubkey, protocol_fee_collector
    );
}

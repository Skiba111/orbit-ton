// Charge engine — the heart of ORBIT.
//
// Security properties guaranteed here:
//
//  1. Double-charge guard   charging_in_progress flag; set before, cleared after
//  2. Rate limiting         next_billing_time check with CHARGE_TOLERANCE_SEC
//  3. Replay protection     seqno monotonicity (enforced by role-manager)
//  4. Storage protection    raw_reserve(STORAGE_RESERVE) before every send
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
fun send_charge_notification(
    factory_addr:   slice,
    plan_id:        int,
    amount:         int,
    subscriber_addr: slice,
    keeper_mode:    int,
    keeper_wallet:  slice
) {
    var body_builder = begin_cell()
        .store_uint(OP_CHARGE_NOTIFICATION, 32)
        .store_uint(0, 64)
        .store_uint(plan_id, 32)
        .store_coins(amount)
        .store_uint(keeper_mode, 1); // has_keeper flag

    var body: cell = (keeper_mode == 1)
        ? body_builder.store_slice(keeper_wallet).end_cell()
        : body_builder.end_cell();
    var msg: cell = begin_cell()
        .store_uint(0x10, 6)       // non-bounceable
        .store_slice(factory_addr)
        .store_coins(FEE_MSG_GAS)  // minimal gas for notification
        .store_uint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .store_ref(body)
    .end_cell();
    send_raw_message(msg, 0); // mode 0 = pay from contract balance
}

// ── Keeper reward ─────────────────────────────────────────────────────────────

fun send_keeper_reward(keeper_wallet: slice) {
    var msg: cell = begin_cell()
        .store_uint(0x10, 6)       // non-bounceable
        .store_slice(keeper_wallet)
        .store_coins(KEEPER_REWARD)
        .store_uint(0, 107)
    .end_cell();
    send_raw_message(msg, 0);
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
    keeper_wallet:          slice   // addr_none when keeper_mode == 0
) {
    throw_if(ERROR_ALREADY_CHARGING, charging_in_progress == 1);
    require_chargeable(status);
    throw_unless(ERROR_TOO_EARLY, is_billing_due(next_billing_time));

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
            fee_collector, jetton_wallet, relayer_pubkey
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
                fee_collector, jetton_wallet, relayer_pubkey
            );
            send_refund(subscriber_addr, deposit, storage_reserve);
            return;
        }
    }

    // Insufficient deposit — enter or extend grace, or cancel
    if (~ has_funds_for_charge(deposit, amount, storage_reserve)) {
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
                fee_collector, jetton_wallet, relayer_pubkey
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
                fee_collector, jetton_wallet, relayer_pubkey
            );
        }
        return;
    }

    // ── All checks passed — execute billing ───────────────────────────────────

    var new_deposit:     int = safe_sub(deposit, amount);
    var (net_amount, fee_amount) = split_fee(amount, fee_bps);
    var new_next_billing: int = advance_billing(next_billing_time, period);
    var new_periods_charged: int = periods_charged + 1;

    var new_status: int = STATUS_AC
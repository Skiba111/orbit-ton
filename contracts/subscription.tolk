// Subscription Contract — main per-user contract.
//
// One of these is deployed per subscriber by the Factory contract.
// Holds the subscriber's pre-funded deposit and executes billing cycles.
//
// Entry points:
//   recv_external  — relayer/keeper triggers billing (OP_CHARGE_EXT)
//   recv_internal  — subscriber: OP_CANCEL, OP_TOP_UP
//                    service:    OP_PAUSE_SUB, OP_RESUME_SUB, OP_EMERGENCY_PAUSE, OP_ROTATE_RELAYER
//                    factory:    OP_APPLY_PLAN
//                    system:     OP_JETTON_TRANSFER_NOTIFICATION, OP_JETTON_EXCESSES
//                    bounce:     handles bounced charge messages
//
// Jetton auto-learn:
//   The jetton_wallet is set to addr_none at deploy for Jetton subscriptions.
//   The first OP_JETTON_TRANSFER_NOTIFICATION from any address sets it permanently.
//   All subsequent notifications must originate from that same address.
//   This is standard TON Jetton pattern (Jetton wallet address is deterministic
//   but not known until the first transfer arrives).
//
// External message layouts:
//   Standard (keeper_mode=0):
//     [512] signature  [32] seqno  [32] timestamp  [32] op=OP_CHARGE_EXT
//   Keeper (keeper_mode=1):
//     [32] seqno  [32] timestamp  [32] op=OP_CHARGE_EXT  [addr] keeper_wallet

import "../utils/errors.tolk"
import "../utils/ops.tolk"
import "../utils/math-safe.tolk"
import "../utils/time-oracle.tolk"
import "../core/subscription-state.tolk"
import "../core/storage-layout.tolk"
import "../core/period-math.tolk"
import "../access/role-manager.tolk"
import "../access/emergency-pause.tolk"
import "../billing/charge-engine.tolk"
import "../billing/fee-router.tolk"
import "../payment/ton-adapter.tolk"
import "../payment/jetton-adapter.tolk"

// ── External message handler (relayer / keeper) ──────────────────────────────

fun recv_external(in_msg: slice) {
    var (
        seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
        retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
        amount, deposit, storage_reserve, fee_bps, trial_period,
        service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
        relayer_pubkey
    ) = load_storage();

    var keeper_wallet: slice = begin_cell().store_uint(0, 2).end_cell().begin_parse();

    if (keeper_mode == 0) {
        var sig: slice  = in_msg.load_bits(512);
        var msg_hash: int = slice_hash(in_msg);
        var incoming_seqno: int = in_msg.load_uint(32);
        var timestamp:      int = in_msg.load_uint(32);
        var op:             int = in_msg.load_uint(32);

        throw_unless(ERROR_INVALID_OP, op == OP_CHARGE_EXT);
        require_not_paused(paused_global);
        require_seqno(incoming_seqno, seqno);
        throw_unless(ERROR_MSG_EXPIRED, is_msg_fresh(timestamp));
        require_valid_signature(msg_hash, sig, relayer_pubkey);
        accept_message();
    } else {
        var incoming_seqno: int = in_msg.load_uint(32);
        var timestamp:      int = in_msg.load_uint(32);
        var op:             int = in_msg.load_uint(32);
        keeper_wallet = in_msg.load_msg_addr();

        throw_unless(ERROR_INVALID_OP, op == OP_CHARGE_EXT);
        require_not_paused(paused_global);
        require_seqno(incoming_seqno, seqno);
        throw_unless(ERROR_MSG_EXPIRED, is_msg_fresh(timestamp));
        accept_message();
    }

    execute_charge(
        seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
        retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
        amount, deposit, storage_reserve, fee_bps, trial_period,
        service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
        relayer_pubkey, keeper_wallet
    );
}

// ── Internal message handler ──────────────────────────────────────────────────

fun recv_internal(my_balance: int, msg_value: int, in_msg_full: cell, in_msg_body: slice) {
    // Plain TON send (empty body) → add to deposit
    if (in_msg_body.slice_empty?()) {
        var (
            seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
            retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
            amount, deposit, storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            relayer_pubkey
        ) = load_storage();
        save_storage(
            seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
            retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
            amount, safe_add(deposit, msg_value), storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            relayer_pubkey
        );
        return;
    }

    var cs: slice = in_msg_full.begin_parse();
    var flags: int = cs.load_uint(4);

    // ── Bounce handler ────────────────────────────────────────────────────────
    if (flags & 1) {
        in_msg_body~load_uint(32); // skip 0xFFFFFFFF bounce prefix
        var op: int = in_msg_body.load_uint(32);
        if (op == OP_CHARGE_INTERNAL) {
            var (
                seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
                retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
                amount, deposit, storage_reserve, fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
                relayer_pubkey
            ) = load_storage();
            on_charge_bounced(
                seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
                retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
                amount, deposit, storage_reserve, fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
                relayer_pubkey
            );
        }
        return;
    }

    var sender: slice = cs.load_msg_addr();
    var op:     int   = in_msg_body.load_uint(32);
    in_msg_body~load_uint(64); // query_id

    var (
        seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
        retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
        amount, deposit, storage_reserve, fee_bps, trial_period,
        service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
        relayer_pubkey
    ) = load_storage();

    // ── OP_CANCEL ─────────────────────────────────────────────────────────────
    if (op == OP_CANCEL) {
        require_owner_or_subscriber(sender, service_addr, subscriber_addr);
        require_not_paused(paused_global);
        require_not_cancelled(status);
        throw_if(ERROR_ALREADY_CHARGING, charging_in_progress == 1);

        save_storage(
            seqno + 1, STATUS_CANCELLED, payment_type, 0, paused_global, keeper_mode,
            retry_count, period, next_billing_time, 0, plan_id, max_periods, periods_charged,
            amount, 0, storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            relayer_pubkey
        );

        // For Jetton subscriptions, refund Jetton tokens + remaining TON separately.
        // For TON subscriptions, refund the TON deposit.
        if (payment_type == PAYMENT_JETTON) {
            var my_addr: slice = my_address();
            send_refund_jetton(jetton_wallet, subscriber_addr, deposit, my_addr);
            // Return any remaining TON above storage_reserve to subscriber
            raw_reserve(storage_reserve, 0);
            var ton_msg: cell = begin_cell()
                .store_uint(0x10, 6)       // non-bounceable
                .store_slice(subscriber_addr)
                .store_coins(0)
                .store_uint(0, 107)
            .end_cell();
            send_raw_message(ton_msg, 128); // send all remaining after reserve
        } else {
            send_refund(subscriber_addr, deposit, storage_reserve);
        }
        return;
    }

    // ── OP_TOP_UP ─────────────────────────────────────────────────────────────
    if (op == OP_TOP_UP) {
        require_subscriber(sender, subscriber_addr);
        require_not_cancelled(status);

        // For TON subscriptions, msg_value is added to deposit.
        // For Jetton subscriptions, msg_value is TON gas only — deposit is via Jetton.
        var new_deposit: int = deposit;
        if (payment_type == PAYMENT_TON) {
            new_deposit = safe_add(deposit, msg_value);
        }
        var new_status: int = status;
        if ((status == STATUS_GRACE) & has_funds_for_charge(new_deposit, amount, storage_reserve)) {
            new_status = STATUS_ACTIVE;
        }

        save_storage(
            seqno + 1, new_status, payment_type, charging_in_progress, paused_global, keeper_mode,
            0, period, next_billing_time, 0, plan_id, max_periods, periods_charged,
            amount, new_deposit, storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            relayer_pubkey
        );
        return;
    }

    // ── OP_PAUSE_SUB ──────────────────────────────────────────────────────────
    if (op == OP_PAUSE_SUB) {
        require_owner(sender, service_addr);
        require_active_or_trial(status);

        save_storage(
            seqno + 1, STATUS_PAUSED, payment_type, 0, paused_global, keeper_mode,
            retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
            amount, deposit, storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            relayer_pubkey
        );
        return;
    }

    // ── OP_RESUME_SUB ─────────────────────────────────────────────────────────
    if (op == OP_RESUME_SUB) {
        require_owner(sender, service_addr);
        require_paused(status);

        save_storage(
            seqno + 1, STATUS_ACTIVE, payment_type, 0, paused_global, keeper_mode,
            retry_count, period, now() + period, 0, plan_id, max_periods, periods_charged,
            amount, deposit, storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            relayer_pubkey
        );
        return;
    }

    // ── OP_EMERGENCY_PAUSE ────────────────────────────────────────────────────
    if (op == OP_EMERGENCY_PAUSE) {
        require_owner(sender, service_addr);
        save_storage(
            seqno + 1, status, payment_type, 0, toggle_pause(paused_global), keeper_mode,
            retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
            amount, deposit, storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            relayer_pubkey
        );
        return;
    }

    // ── OP_ROTATE_RELAYER ─────────────────────────────────────────────────────
    if (op == OP_ROTATE_RELAYER) {
        require_owner(sender, service_addr);
        var new_pubkey: int = in_msg_body.load_uint(256);
        throw_if(ERROR_INVALID_STATE, (new_pubkey == 0) & (keeper_mode == 0));

        save_storage(
            seqno + 1, status, 
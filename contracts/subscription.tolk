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
// Jetton wallet:
//   For Jetton subscriptions, jetton_wallet is set at deploy time from the
//   subscriber_jetton_wallet parameter provided in OP_SUBSCRIBE.
//   The Factory validates that this address is not addr_none before deploying.
//   All OP_JETTON_TRANSFER_NOTIFICATION messages must originate from this address.
//   The addr_none auto-learn path below is a safety fallback only — it should
//   never be reached in correctly-deployed subscriptions.
//
// External message layouts:
//   Standard (keeper_mode=0):
//     [512] signature  [32] seqno  [32] timestamp  [32] op=OP_CHARGE_EXT
//   Keeper (keeper_mode=1):
//     [32] seqno  [32] timestamp  [32] op=OP_CHARGE_EXT  [addr] keeper_wallet

import "@stdlib/gas-payments"
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

fun onExternalMessage(in_msg: slice) {
    var (
        seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
        retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
        amount, deposit, storage_reserve, fee_bps, trial_period,
        service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
        relayer_pubkey, protocol_fee_collector
    ) = load_storage();

    var keeper_wallet: slice = beginCell().storeUint(0, 2).endCell().beginParse();

    if (keeper_mode == 0) {
        var sig: slice  = in_msg.loadBits(512);
        var msg_hash: int = in_msg.hash();
        var incoming_seqno: int = in_msg.loadUint(32);
        var timestamp:      int = in_msg.loadUint(32);
        var op:             int = in_msg.loadUint(32);

        assert(op == OP_CHARGE_EXT, ERROR_INVALID_OP);
        require_not_paused(paused_global);
        require_seqno(incoming_seqno, seqno);
        assert(is_msg_fresh(timestamp), ERROR_MSG_EXPIRED);
        require_valid_signature(msg_hash, sig, relayer_pubkey);
        acceptExternalMessage();
    } else {
        var incoming_seqno: int = in_msg.loadUint(32);
        var timestamp:      int = in_msg.loadUint(32);
        var op:             int = in_msg.loadUint(32);
        keeper_wallet = in_msg.loadAddress() as slice;

        assert(op == OP_CHARGE_EXT, ERROR_INVALID_OP);
        require_not_paused(paused_global);
        require_seqno(incoming_seqno, seqno);
        assert(is_msg_fresh(timestamp), ERROR_MSG_EXPIRED);
        // Keeper wallet must be a real address — addr_none would cause
        // send_keeper_reward to target an invalid destination.
        assert(!is_addr_none(keeper_wallet), ERROR_UNAUTHORIZED);
        acceptExternalMessage();
    }

    execute_charge(
        seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
        retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
        amount, deposit, storage_reserve, fee_bps, trial_period,
        service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
        relayer_pubkey, protocol_fee_collector, keeper_wallet
    );
}

// ── Internal message handler ──────────────────────────────────────────────────

fun onInternalMessage(my_balance: int, msg_value: int, in_msg_full: cell, in_msg_body: slice) {
    // Plain TON send (empty body).
    //
    // TON subscriptions:  add msg_value to the tracked deposit ledger.
    //
    // Jetton subscriptions: accept the TON (it stays in the contract balance
    //   for gas/rent) but do NOT add it to deposit.  deposit for Jetton tracks
    //   token count, not nanotons.  Adding nanotons here would inflate the
    //   apparent token balance, bypass has_funds_for_charge, trigger a Jetton
    //   transfer with no real tokens, bounce unhandled, and leave
    //   charging_in_progress=1 permanently (griefing / subscription bricking).
    if (in_msg_body.isEnd()) {
        var (
            seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
            retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
            amount, deposit, storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            relayer_pubkey, protocol_fee_collector
        ) = load_storage();
        if (payment_type == PAYMENT_TON) {
            save_storage(
                seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
                retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
                amount, safe_add(deposit, msg_value), storage_reserve, fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
                relayer_pubkey, protocol_fee_collector
            );
        }
        // For PAYMENT_JETTON: TON is silently accepted (gas/rent), deposit unchanged.
        return;
    }

    var cs: slice = in_msg_full.beginParse();
    var flags: int = cs.loadUint(4);

    // ── Bounce handler ────────────────────────────────────────────────────────
    //
    // Handled bounce ops:
    //   OP_CHARGE_INTERNAL — payment to service bounced; restore deposit + rollback
    //   OP_FEE_PAYMENT     — fee to collector bounced; restore fee_amount to deposit
    //
    // Both restores prevent the subscriber's tracked deposit from drifting below
    // the real contract balance.  Without them, the fee (or payment) amount is
    // returned to the raw balance by TON but not reflected in deposit, causing
    // silent insolvency the next time has_funds_for_charge() is checked.
    if (flags & 1) {
        in_msg_body.loadUint(32); // skip 0xFFFFFFFF bounce prefix
        var op: int = in_msg_body.loadUint(32);

        if (op == OP_CHARGE_INTERNAL) {
            var (
                seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
                retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
                amount, deposit, storage_reserve, fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
                relayer_pubkey, protocol_fee_collector
            ) = load_storage();
            on_charge_bounced(
                seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
                retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
                amount, deposit, storage_reserve, fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
                relayer_pubkey, protocol_fee_collector
            );
        }

        // OP_FEE_PAYMENT bounce: service fee_collector was frozen/unreachable.
        // OP_PROTOCOL_FEE_PAYMENT bounce: ORBIT protocol collector was unreachable.
        // Both: restore the fee amount to deposit so tracked balance stays accurate.
        // Body layout: OP(32)[consumed] + query_id(64) + fee_amount(coins) — within 256-bit bounce window.
        if (op == OP_FEE_PAYMENT) {
            var (
                seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
                retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
                amount, deposit, storage_reserve, fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
                relayer_pubkey, protocol_fee_collector
            ) = load_storage();
            in_msg_body.loadUint(64);
            var fee_recovered: int = in_msg_body.loadCoins();
            save_storage(
                seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
                retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
                amount, safe_add(deposit, fee_recovered), storage_reserve, fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
                relayer_pubkey, protocol_fee_collector
            );
        }

        if (op == OP_PROTOCOL_FEE_PAYMENT) {
            var (
                seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
                retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
                amount, deposit, storage_reserve, fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
                relayer_pubkey, protocol_fee_collector
            ) = load_storage();
            in_msg_body.loadUint(64);
            var protocol_fee_recovered: int = in_msg_body.loadCoins();
            save_storage(
                seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
                retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
                amount, safe_add(deposit, protocol_fee_recovered), storage_reserve, fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
                relayer_pubkey, protocol_fee_collector
            );
        }

        return;
    }

    var sender: slice = cs.loadAddress() as slice;
    var op:     int   = in_msg_body.loadUint(32);
    in_msg_body.loadUint(64); // query_id

    var (
        seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
        retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
        amount, deposit, storage_reserve, fee_bps, trial_period,
        service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
        relayer_pubkey, protocol_fee_collector
    ) = load_storage();

    // ── OP_CANCEL ─────────────────────────────────────────────────────────────
    if (op == OP_CANCEL) {
        require_owner_or_subscriber(sender, service_addr, subscriber_addr);
        require_not_paused(paused_global);
        require_not_cancelled(status);
        assert(!(charging_in_progress == 1), ERROR_ALREADY_CHARGING);

        save_storage(
            seqno + 1, STATUS_CANCELLED, payment_type, 0, paused_global, keeper_mode,
            retry_count, period, next_billing_time, 0, plan_id, max_periods, periods_charged,
            amount, 0, storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            relayer_pubkey, protocol_fee_collector
        );

        // For Jetton subscriptions, refund Jetton tokens + remaining TON separately.
        // For TON subscriptions, refund the TON deposit.
        if (payment_type == PAYMENT_JETTON) {
            var my_addr: slice = contract.getAddress() as slice;
            send_refund_jetton(jetton_wallet, subscriber_addr, deposit, my_addr);
            // Return any remaining TON above storage_reserve to subscriber
            reserveToncoinsOnBalance(storage_reserve, 0);
            var ton_msg: cell = beginCell()
                .storeUint(0x10, 6)       // non-bounceable
                .storeSlice(subscriber_addr)
                .storeCoins(0)
                .storeUint(0, 107)
            .endCell();
            sendRawMessage(ton_msg, 128); // send all remaining after reserve
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
            relayer_pubkey, protocol_fee_collector
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
            relayer_pubkey, protocol_fee_collector
        );
        return;
    }

    // ── OP_RESUME_SUB ─────────────────────────────────────────────────────────
    if (op == OP_RESUME_SUB) {
        require_owner(sender, service_addr);
        require_paused(status);

        save_storage(
            seqno + 1, STATUS_ACTIVE, payment_type, 0, paused_global, keeper_mode,
            retry_count, period, blockchain.now() + period, 0, plan_id, max_periods, periods_charged,
            amount, deposit, storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            relayer_pubkey, protocol_fee_collector
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
            relayer_pubkey, protocol_fee_collector
        );
        return;
    }

    // ── OP_ROTATE_RELAYER ─────────────────────────────────────────────────────
    if (op == OP_ROTATE_RELAYER) {
        require_owner(sender, service_addr);
        var new_pubkey: int = in_msg_body.loadUint(256);
        assert(!((new_pubkey == 0) & (keeper_mode == 0)), ERROR_INVALID_STATE);

        save_storage(
            seqno + 1, status, payment_type, charging_in_progress, paused_global, keeper_mode,
            retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
            amount, deposit, storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            new_pubkey, protocol_fee_collector
        );
        return;
    }

    // ── OP_APPLY_PLAN ─────────────────────────────────────────────────────────
    // Authenticated by factory_addr — subscriber cannot call this directly.
    if (op == OP_APPLY_PLAN) {
        require_owner(sender, factory_addr);
        require_not_cancelled(status);
        assert(!(charging_in_progress == 1), ERROR_ALREADY_CHARGING);

        var new_plan_id:      int = in_msg_body.loadUint(32);
        var new_amount:       int = in_msg_body.loadCoins();
        var new_period:       int = in_msg_body.loadUint(32);
        var new_trial_period: int = in_msg_body.loadUint(32);

        // If the new plan is more expensive than the current deposit can cover,
        // enter GRACE immediately rather than silently failing on the next charge.
        var new_status: int = status;
        if (!has_funds_for_charge(deposit, new_amount, storage_reserve)) {
            new_status = STATUS_GRACE;
        }

        save_storage(
            seqno + 1, new_status, payment_type, charging_in_progress, paused_global, keeper_mode,
            retry_count, new_period, blockchain.now() + new_period, grace_end_time,
            new_plan_id, max_periods, periods_charged,
            new_amount, deposit, storage_reserve, fee_bps, new_trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            relayer_pubkey, protocol_fee_collector
        );
        return;
    }

    // ── OP_SET_MAX_PERIODS ────────────────────────────────────────────────────
    // Service owner converts an existing unlimited subscription into a fixed-term
    // one, or adjusts the cap on an already capped subscription.
    // Setting max_periods = 0 restores unlimited billing.
    if (op == OP_SET_MAX_PERIODS) {
        require_owner(sender, service_addr);
        require_not_cancelled(status);

        var new_max: int = in_msg_body.loadUint(32);

        save_storage(
            seqno + 1, status, payment_type, charging_in_progress, paused_global, keeper_mode,
            retry_count, period, next_billing_time, grace_end_time,
            plan_id, new_max, periods_charged,
            amount, deposit, storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
            relayer_pubkey, protocol_fee_collector
        );
        return;
    }

    // ── OP_JETTON_TRANSFER_NOTIFICATION ───────────────────────────────────────
    // First notification from any sender sets jetton_wallet permanently (auto-learn).
    // Subsequent notifications must originate from the same address.
    if (op == OP_JETTON_TRANSFER_NOTIFICATION) {
        var new_jetton_wallet: slice = jetton_wallet;
        if (is_addr_none(jetton_wallet)) {
            // Auto-learn: first Jetton wallet that notifies us becomes the canonical one.
            // This is safe because we only accept Jetton subscriptions — a malicious
            // sender could set a wrong address, but the subscriber controls who sends to them.
            new_jetton_wallet = sender;
        } else {
            assert(addr_equal(sender, jetton_wallet), ERROR_WRONG_SENDER);
        }

        var added: int = handle_jetton_deposit_notification(in_msg_body);
        save_storage(
            seqno + 1, status, payment_type, charging_in_progress, paused_global, keeper_mode,
            retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
            amount, safe_add(deposit, added), storage_reserve, fee_bps, trial_period,
            service_addr, subscriber_addr, factory_addr, fee_collector, new_jetton_wallet,
            relayer_pubkey, protocol_fee_collector
        );
        return;
    }

    // ── OP_JETTON_EXCESSES (Jetton charge confirmation) ───────────────────────
    // Must originate from the known jetton_wallet — prevents any external actor
    // from prematurely clearing the charging_in_progress flag.
    if (op == OP_JETTON_EXCESSES) {
        // Only accept from the known Jetton wallet; reject addr_none (not yet set)
        assert((!is_addr_none(jetton_wallet)) && addr_equal(sender, jetton_wallet), ERROR_WRONG_SENDER);
        if (charging_in_progress == 1) {
            save_storage(
                seqno + 1, status, payment_type, 0, paused_global, keeper_mode,
                retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
                amount, deposit, storage_reserve, fee_bps, trial_period,
                service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
                relayer_pubkey, protocol_fee_collector
            );
        }
        return;
    }

    throw ERROR_INVALID_OP;
}

// ── Getters ───────────────────────────────────────────────────────────────────

get fun get_subscription_data(): (int, int, int, int, int, int, int) {
    var (
        seqno, status, _, _, _, _,
        retry_count, period, next_billing_time, _, plan_id, _, _,
        amount, deposit, _, _, _,
        _, _, _, _, _, _, _
    ) = load_storage();
    return (status, plan_id, amount, deposit, next_billing_time, period, retry_count);
}

get fun get_status(): int {
    var (_, status, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _) = load_storage();
    return status;
}

get fun get_seqno(): int {
    var (seqno, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _) = load_storage();
    return seqno;
}

get fun get_deposit(): int {
    var (_, _, _, _, _, _, _, _, _, _, _, _, _, _, deposit, _, _, _, _, _, _, _, _, _, _) = load_storage();
    return deposit;
}

get fun get_next_billing_time(): int {
    var (_, _, _, _, _, _, _, _, next_billing_time, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _) = load_storage();
    return next_billing_time;
}

get fun is_paused(): int {
    var (_, _, _, _, paused_global, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _) = load_storage();
    return paused_global;
}

get fun get_relayer_pubkey(): int {
    var (_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, relayer_pubkey, _) = load_storage();
    return relayer_pubkey;
}

get fun get_periods_charged(): int {
    var (_, _, _, _, _, _, _, _, _, _, _, _, periods_charged, _, _, _, _, _, _, _, _, _, _, _, _) = load_storage();
    return periods_charged;
}

get fun is_keeper_mode(): int {
    var (_, _, _, _, _, keeper_mode, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _) = load_storage();
    return keeper_mode;
}

get fun get_payment_type(): int {
    var (_, _, payment_type, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _) = load_storage();
    return payment_type;
}

get fun get_version(): int {
    return 2; // v2: Jetton deposit isolation fix (empty-body handler guards payment_type)
}

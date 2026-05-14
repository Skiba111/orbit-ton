// Factory Contract — deployed once per service.
//
// Responsibilities:
//   1. Holds the plan registry (dict of plans).
//   2. Deploys per-user Subscription contracts at deterministic addresses.
//   3. Tracks which subscribers have used their trial and stores their sub address.
//   4. Manages the global pause flag for new subscriptions.
//   5. Forwards OP_APPLY_PLAN for subscriber-initiated plan changes.
//   6. Accumulates MRR analytics from OP_CHARGE_NOTIFICATION.
//   7. Manages the keeper reward pool (service pre-funds; keepers withdraw per charge).
//
// Storage layout:
//   Root bits:
//     [256] relayer_pubkey
//     [32]  seqno
//     [1]   paused
//     [32]  plan_count
//     [16]  fee_bps
//     [64]  total_charges (analytics)
//     [var] total_revenue (analytics, coins)
//     [var] keeper_pool   (TON reserved for keeper rewards, coins)
//   Refs (4 max):
//     ref0: plans dict         — plan_id(uint32) → PlanData cell
//     ref1: subscriber_info    — subscriber_hash(uint256) → sub_addr(267) + ever_trial_used(1)
//     ref2: subscription_code
//     ref3: addresses          — service_addr + fee_collector
//
// subscriber_info dict design:
//   Key:   slice_hash(subscriber_addr) — 256 bits
//   Value: sub_addr(addr_std, 267 bits) + ever_trial_used(1 bit)
//   Stored at first OP_SUBSCRIBE; updated on re-subscribe.
//   Provides deterministic subscription address lookup for OP_CHANGE_PLAN.

import "../utils/errors.tolk"
import "../utils/ops.tolk"
import "../utils/math-safe.tolk"
import "../utils/time-oracle.tolk"
import "../core/storage-layout.tolk"
import "../core/subscription-state.tolk"
import "../access/role-manager.tolk"
import "../access/emergency-pause.tolk"
import "../plans/plan-registry.tolk"
import "../plans/trial-logic.tolk"

const FACTORY_DEPLOY_GAS:  int = 50000000;   // 0.05 TON — factory execution cost
const FACTORY_RESERVE:     int = 100000000;  // 0.1 TON — factory's own rent
// KEEPER_REWARD is defined in utils/math-safe.tolk (shared with charge-engine)

// ── subscriber_info dict helpers ──────────────────────────────────────────────

// Returns (sub_addr, ever_trial_used).  sub_addr is addr_none if subscriber not found.
fun get_subscriber_info(subscriber_info: cell, subscriber_hash: int): (slice, int) {
    var (val, found) = subscriber_info.udict_get?(256, subscriber_hash);
    if (~ found) {
        var zero: slice = begin_cell().store_uint(0, 2).end_cell().begin_parse();
        return (zero, 0);
    }
    var sub_addr:       slice = val.load_msg_addr();
    var ever_trial_used: int  = val.load_uint(1);
    return (sub_addr, ever_trial_used);
}

// Returns true when sub_addr is addr_none (subscriber has never subscribed through us).
@inline
fun sub_addr_is_none(sub_addr: slice): int {
    return sub_addr.preload_uint(2) == 0;
}

fun set_subscriber_info(
    subscriber_info:  cell,
    subscriber_hash:  int,
    sub_addr:         slice,
    ever_trial_used:  int
): cell {
    var val: slice = begin_cell()
        .store_slice(sub_addr)
        .store_uint(ever_trial_used, 1)
    .end_cell().begin_parse();
    return subscriber_info.udict_set(256, subscriber_hash, val);
}

// ── Storage helpers ───────────────────────────────────────────────────────────

fun load_factory_storage(): (int, int, int, int, int, int, int, int, cell, cell, cell, slice, slice) {
    var ds: slice = get_data().begin_parse();
    var relayer_pubkey:  int  = ds.load_uint(256);
    var seqno:           int  = ds.load_uint(32);
    var paused:          int  = ds.load_uint(1);
    var plan_count:      int  = ds.load_uint(32);
    var fee_bps:         int  = ds.load_uint(16);
    var total_charges:   int  = ds.load_uint(64);
    var total_revenue:   int  = ds.load_coins();
    var keeper_pool:     int  = ds.load_coins();
    var plans:           cell = ds.load_ref();
    var subscriber_info: cell = ds.load_ref();
    var sub_code:        cell = ds.load_ref();
    var addr_ref:        slice = ds.load_ref().begin_parse();
    var service_addr:    slice = addr_ref.load_msg_addr();
    var fee_collector:   slice = addr_ref.load_msg_addr();
    return (relayer_pubkey, seqno, paused, plan_count, fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector);
}

fun save_factory_storage(
    relayer_pubkey: int, seqno: int, paused: int, plan_count: int, fee_bps: int,
    total_charges: int, total_revenue: int, keeper_pool: int,
    plans: cell, subscriber_info: cell, sub_code: cell,
    service_addr: slice, fee_collector: slice
) {
    set_data(
        begin_cell()
            .store_uint(relayer_pubkey,  256)
            .store_uint(seqno,            32)
            .store_uint(paused,            1)
            .store_uint(plan_count,       32)
            .store_uint(fee_bps,          16)
            .store_uint(total_charges,    64)
            .store_coins(total_revenue)
            .store_coins(keeper_pool)
            .store_ref(plans)
            .store_ref(subscriber_info)
            .store_ref(sub_code)
            .store_ref(
                begin_cell()
                    .store_slice(service_addr)
                    .store_slice(fee_collector)
                .end_cell()
            )
        .end_cell()
    );
}

// ── Subscription StateInit builder ───────────────────────────────────────────

fun build_sub_init(
    subscriber_addr:      slice,
    plan_id:              int,
    price:                int,
    period:               int,
    trial_period:         int,
    trial_used:           int,
    payment_type:         int,    // PAYMENT_TON(1) or PAYMENT_JETTON(2)
    subscriber_jetton_wallet: slice, // addr_none for TON subscriptions
    service_addr:         slice,
    fee_collector:        slice,
    fee_bps:              int,
    relayer_pubkey:       int,
    factory_addr:         slice,
    sub_code:             cell
): cell {
    var init_status:  int = initial_status(trial_period, trial_used);
    var init_billing: int = initial_billing_time(trial_period, period, trial_used);

    var state_data: cell = pack_subscription(
        0,               // seqno
        init_status,
        payment_type,    // TON or JETTON — set by subscriber at subscribe time
        0,               // charging_in_progress
        0,               // paused_global
        0,               // keeper_mode — off by default
        0,               // retry_count
        period,
        init_billing,
        0,               // grace_end_time
        plan_id,
        0,               // max_periods — 0 = unlimited
        0,               // periods_charged
        price,           // amount — locked snapshot
        0,               // deposit — subscriber funds via the deploy message value
        STORAGE_RESERVE,
        fee_bps,
        trial_period,
        service_addr,
        subscriber_addr,
        factory_addr,
        fee_collector,
        subscriber_jetton_wallet, // addr_none for TON; actual wallet for Jetton
        relayer_pubkey
    );

    return begin_cell()
        .store_uint(6, 5)   // StateInit TL-B: split_depth=0, special=0, code=1, data=1, library=0
        .store_ref(sub_code)
        .store_ref(state_data)
    .end_cell();
}

// Computes addr_std = workchain:SHA256(StateInit).
fun compute_contract_addr(state_init: cell): slice {
    var state_hash: int = cell_hash(state_init);
    return begin_cell()
        .store_uint(4, 3)    // addr_std tag: 0b100 (no anycast)
        .store_int(0, 8)     // workchain = 0
        .store_uint(state_hash, 256)
    .end_cell().begin_parse();
}

// Builds OP_APPLY_PLAN body sent by factory to a subscription contract.
fun build_apply_plan_body(
    plan_id: int, price: int, period: int, trial_period: int
): cell {
    return begin_cell()
        .store_uint(OP_APPLY_PLAN, 32)
        .store_uint(0, 64)
        .store_uint(plan_id, 32)
        .store_coins(price)
        .store_uint(period, 32)
        .store_uint(trial_period, 32)
    .end_cell();
}

// ── Internal message handler ──────────────────────────────────────────────────

fun recv_internal(my_balance: int, msg_value: int, in_msg_full: cell, in_msg_body: slice) {
    if (in_msg_body.slice_empty?()) { return; } // accept plain TON deposits

    var cs: slice = in_msg_full.begin_parse();
    var flags: int = cs.load_uint(4);
    if (flags & 1) { return; } // ignore all bounced messages

    var sender: slice = cs.load_msg_addr();
    var op: int = in_msg_body.load_uint(32);
    in_msg_body~load_uint(64); // query_id

    var (
        relayer_pubkey, seqno, paused, plan_count, fee_bps,
        total_charges, total_revenue, keeper_pool,
        plans, subscriber_info, sub_code, service_addr, fee_collector
    ) = load_factory_storage();

    // ── OP_SUBSCRIBE ──────────────────────────────────────────────────────────
    //
    // Body: plan_id(32) + payment_type(2) + [if JETTON: jetton_wallet(addr_std)]
    //
    // Minimum value check (Bug #4 fix): reject subscriptions that cannot fund
    // even one billing cycle — prevents deploying always-insolvent subscriptions.
    if (op == OP_SUBSCRIBE) {
        require_not_paused(paused);

        var plan_id:      int = in_msg_body.load_uint(32);
        var payment_type: int = in_msg_body.load_uint(2);
        throw_unless(ERROR_INVALID_OP, (payment_type == PAYMENT_TON) | (payment_type == PAYMENT_JETTON));

        // Read optional jetton_wallet (only present when payment_type == PAYMENT_JETTON)
        var subscriber_jetton_wallet: slice = begin_cell().store_uint(0, 2).end_cell().begin_parse();
        if (payment_type == PAYMENT_JETTON) {
            subscriber_jetton_wallet = in_msg_body.load_msg_addr();
        }

        var (price, period, trial_period) = require_active_plan(plans, plan_id);

        // Enforce minimum deposit: at least one billing cycle + reserve + gas.
        // For Jetton subscriptions, the TON value only covers gas/rent — no price check.
        if (payment_type == PAYMENT_TON) {
            var min_value: int = safe_add(safe_add(price, STORAGE_RESERVE), FACTORY_DEPLOY_GAS);
            throw_unless(ERROR_INSUFFICIENT_FUNDS, msg_value >= min_value);
        } else {
            throw_unless(ERROR_INSUFFICIENT_FUNDS, msg_value >= safe_add(STORAGE_RESERVE, FACTORY_DEPLOY_GAS));
        }

        var sender_hash:  int = slice_hash(sender);
        var (_, ever_trial_used) = get_subscriber_info(subscriber_info, sender_hash);

        var my_addr: slice = my_address();
        var init_state: cell = build_sub_init(
            sender, plan_id, price, period, trial_period,
            ever_trial_used,      // trial_used at this subscribe time
            payment_type,
            subscriber_jetton_wallet,
            service_addr, fee_collector, fee_bps,
            relayer_pubkey, my_addr, sub_code
        );
        var sub_addr: slice = compute_contract_addr(init_state);

        var deposit: int = safe_sub(msg_value, FACTORY_DEPLOY_GAS);

        var msg: cell = begin_cell()
            .store_uint(0x18, 6)
            .store_slice(sub_addr)
            .store_coins(deposit)
            .store_uint(6, 108)  // 105 zeros + init_present(1) + init_ref(1) + no_body(0)
            .store_ref(init_state)
        .end_cell();
        send_raw_message(msg, 1);

        // Mark trial consumed if applicable
        var new_ever_trial_used: int = ever_trial_used;
        if ((trial_period > 0) & (ever_trial_used == 0)) {
            new_ever_trial_used = 1;
        }

        // Store subscription address in subscriber_info — used for OP_CHANGE_PLAN
        subscriber_info = set_subscriber_info(
            subscriber_info, sender_hash, sub_addr, new_ever_trial_used
        );

        save_factory_storage(
            relayer_pubkey, seqno, paused, plan_count, fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector
        );
        return;
    }

    // ── OP_ADD_PLAN ───────────────────────────────────────────────────────────
    if (op == OP_ADD_PLAN) {
        require_owner(sender, service_addr);
        var new_price:        int = in_msg_body.load_coins();
        var new_period:       int = in_msg_body.load_uint(32);
        var new_trial_period: int = in_msg_body.load_uint(32);
        var new_name_hash:    int = in_msg_body.load_uint(256);

        validate_amount(new_price);
        validate_period(new_period);

        plans = set_plan(plans, plan_count, new_price, new_period, new_trial_period, new_name_hash);
        save_factory_storage(
            relayer_pubkey, seqno, paused, plan_count + 1, fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector
        );
        return;
    }

    // ── OP_DEACTIVATE_PLAN ────────────────────────────────────────────────────
    if (op == OP_DEACTIVATE_PLAN) {
        require_owner(sender, service_addr);
        var target_plan_id: int = in_msg_body.load_uint(32);
        plans = deactivate_plan(plans, target_plan_id);
        save_factory_storage(
            relayer_pubkey, seqno, paused, plan_count, fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector
        );
        return;
    }

    // ── OP_CHANGE_PLAN ────────────────────────────────────────────────────────
    // Subscriber requests a plan change.  Factory validates the new plan and
    // forwards OP_APPLY_PLAN to the subscriber's known subscription address.
    //
    // Security: the subscription address is looked up from subscriber_info —
    // NOT provided by the caller.  This prevents Bob from targeting Alice's
    // subscription with his own OP_CHANGE_PLAN message.
    if (op == OP_CHANGE_PLAN) {
        var new_plan_id: int = in_msg_body.load_uint(32);
        var (new_price, new_period, new_trial_period) = require_active_plan(plans, new_plan_id);

        var sender_hash: int = slice_hash(sender);
        var (sub_addr, _) = get_subscriber_info(subscriber_info, sender_hash);

        // Subscriber must have an existing subscription recorded by this factory
        throw_unless(ERROR_NOT_FOUND, ~ sub_addr_is_none(sub_addr));

        var body: cell = build_apply_plan_body(new_plan_id, new_price, new_period, new_trial_period);
        var fwd_msg: cell = begin_cell()
            .store_uint(0x18, 6)
            .store_slice(sub_addr)
            .store_coins(FACTORY_DEPLOY_GAS)  // 0.05 TON for OP_APPLY_PLAN gas (with safety margin)
            .store_uint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
            .store_ref(body)
        .end_cell();
        send_raw_message(fwd_msg, 0);
        return;
    }

    // ── OP_CHARGE_NOTIFICATION ────────────────────────────────────────────────
    // Subscription notifies us after each successful charge.
    // Auth: sender must match the sub_addr stored for notif_sub_addr in
    // subscriber_info — prevents anyone from spoofing this op to drain keeper_pool.
    if (op == OP_CHARGE_NOTIFICATION) {
        var notif_plan_id:  int   = in_msg_body.load_uint(32);
        var notif_amount:   int   = in_msg_body.load_coins();
        var notif_sub_addr: slice = in_msg_body.load_msg_addr();
        var has_keeper:     int   = in_msg_body.load_uint(1);

        // Verify sender is the known subscription for notif_sub_addr
        var sub_hash: int = slice_hash(notif_sub_addr);
        var (stored_sub_addr, _) = get_subscriber_info(subscriber_info, sub_hash);
        throw_unless(ERROR_WRONG_SENDER,
            (~ sub_addr_is_none(stored_sub_addr)) & addr_equal(sender, stored_sub_addr)
        );

        var new_keeper_pool: int = keeper_pool;
        if (has_keeper) {
            var keeper_wallet: slice = in_msg_body.load_msg_addr();
            // Pay bonus from pool if funded; skip silently if pool empty
            if (new_keeper_pool >= KEEPER_REWARD) {
                new_keeper_pool = safe_sub(new_keeper_pool, KEEPER_REWARD);
                var reward_msg: cell = begin_cell()
                    .store_uint(0x10, 6)  // non-bounceable
                    .store_slice(keeper_wallet)
                    .store_coins(KEEPER_REWARD)
                    .store_uint(0, 107)
                .end_cell();
                send_raw_message(reward_msg, 0);
            }
        }

        save_factory_storage(
            relayer_pubkey, seqno, paused, plan_count, fee_bps,
            total_charges + 1, safe_add(total_revenue, notif_amount), new_keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector
        );
        return;
    }

    // ── OP_FUND_KEEPER_POOL ───────────────────────────────────────────────────
    // Service pre-funds the keeper reward pool.  Any msg_value above minimum
    // is added to keeper_pool.  No auth — anyone can fund the pool.
    if (op == OP_FUND_KEEPER_POOL) {
        // Require at least 0.005 TON above the handling floor to avoid safe_sub underflow
        throw_unless(ERROR_INSUFFICIENT_FUNDS, msg_value > 5000000);
        var contribution: int = safe_sub(msg_value, 5000000); // deduct 0.005 TON msg handling gas
        if (contribution > 0) {
            save_factory_storage(
                relayer_pubkey, seqno, paused, plan_count, fee_bps,
                total_charges, total_revenue, safe_add(keeper_pool, contribution),
                plans, subscriber_info, sub_code, service_addr, fee_collector
            );
        }
        return;
    }

    // ── OP_FACTORY_PAUSE / RESUME ─────────────────────────────────────────────
    if (op == OP_FACTORY_PAUSE) {
        require_owner(sender, service_addr);
        save_factory_storage(
            relayer_pubkey, seqno, 1, plan_count, fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector
        );
        return;
    }

    if (op == OP_FACTORY_RESUME) {
        require_owner(sender, service_addr);
        save_factory_storage(
            relayer_pubkey, seqno, 0, plan_count, fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector
        );
        return;
    }

    // ── OP_UPDATE_FEE_BPS ─────────────────────────────────────────────────────
    // Updates the protocol fee for NEW subscriptions only.
    // Existing subscriptions snapshot fee_bps at deploy time and are unaffected.
    if (op == OP_UPDATE_FEE_BPS) {
        require_owner(sender, service_addr);
        var new_fee_bps: int = in_msg_body.load_uint(16);
        validate_fee_bps(new_fee_bps);
        save_factory_storage(
            relayer_pubkey, seqno, paused, plan_count, new_fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector
        );
        return;
    }

    // ── OP_FACTORY_WITHDRAW ───────────────────────────────────────────────────
    if (op == OP_FACTORY_WITHDRAW) {
        require_owner(sender, service_addr);

        var balance:   int = get_balance().pair_first();
        var available: int = safe_sub(balance, safe_add(FACTORY_RESERVE, keeper_pool));
        throw_unless(ERROR_INSUFFICIENT_FUNDS, available > 0);

        raw_reserve(safe_add(FACTORY_RESERVE, keeper_pool), 0);

        var msg: cell = begin_cell()
            .store_uint(0x10, 6)
            .store_slice(service_addr)
            .store_coins(0)
            .store_uint(0, 107)
        .end_cell();
        send_raw_message(msg, 128);
        return;
    }

    throw(ERROR_INVALID_OP);
}

// ── Getters ───────────────────────────────────────────────────────────────────

get fun get_plan_count(): int {
    var (_, _, _, plan_count, _, _, _, _, _, _, _, _, _) = load_factory_storage();
    return plan_count;
}

get fun get_plan_data(plan_id: int): (int, int, int, int, int) {
    var (_, _, _, _, _, _, _, _, plans, _, _, _, _) = load_factory_storage();
    var (price, period, trial_period, active, name_hash) = unpack_plan(get_plan(plans, plan_id));
    return (price, period, trial_period, active, name_hash);
}

get fun is_factory_paused(): int {
    var (_, _, paused, _, _, _, _, _, _, _, _, _, _) = load_factory_storage();
    return paused;
}

get fun get_subscription_code(): cell {
    var (_, _, _, _, _, _, _, _, _, _, sub_code, _, _) = load_factory_storage();
    return sub_code;
}

get fun get_relayer_pubkey(): int {
    var (relayer_pubkey, _, _, _, _, _, _, _, _, _, _, _, _) = load_factory_storage();
    return relayer_pubkey;
}

get fun get_total_charges(): int {
    var (_, _, _, _, _, total_charges, _, _, _, _, _, _, _) = load_factory_storage();
    return total_charges;
}

get fun get_total_revenue(): int {
    var (_, _, _, _, _, _, total_revenue, _, _, _, _, _, _) = load_factory_storage();
    return total_revenue;
}

get fun get_keeper_pool(): int {
    var (_, _, _, _, _, _, _, keeper_pool, _, _, _, _, _) = load_factory_storage();
    return keeper_pool;
}

get fun get_fee_bps(): int {
    var (_, _, _, _, fee_bps, _, _, _, _, _, _, _, _) = load_factory_storage();
    return fee_bps;
}

get fun get_version(): int {
    return 1; // bumped on every storage-breaking upgrade
}

// Returns the on-chain subscription address for a given subscriber and plan.
// If the subscriber has already subscribed through this factory, returns the
// stored address (canonical).  Otherwise computes it from the plan snapshot.
//
// payment_type: 0 = TON, 1 = JETTON.  Must match what the subscriber will
// pass to OP_SUBSCRIBE.  The payment_type is baked into the init_state cell
// and therefore into the contract address — wrong value → wrong address.
//
// subscriber_jetton_wallet: pass addr_none (store_uint(0,2)) for TON subscriptions.
get fun get_subscription_address(
    subscriber_addr:          slice,
    plan_id:                  int,
    payment_type:             int,
    subscriber_jetton_wallet: slice
): slice {
    var (
        relayer_pubkey, _, _, _, fee_bps, _, _, _,
        plans, subscriber_info, sub_code, service_addr, fee_collector
    ) = load_factory_storage();

    var sub_hash: int = slice_hash(subscriber_addr);
    var (stored_addr, _) = get_subscriber_info(subscriber_info, sub_hash);

    if (~ sub_addr_is_none(stored_addr)) {
        return stored_addr; // canonical address if already subscribed
    }

    // Subscriber has not yet subscribed — compute expected address (trial_used=0)
    var (price, period, trial_period, _, _) = unpack_plan(get_plan(plans, plan_id));
    var my_addr: slice = my_address();
    var init_state: cell = build_sub_init(
        subscriber_addr, plan_id, price, period, trial_period,
        0,                       // trial_used = 0 for first subscribe
        payment_type,
        subscriber_jetton_wallet,
        service_addr, fee_collector, fee_bps,
        relayer_pubkey, my_addr, sub_code
    );
    return compute_contract_addr(init_state);
}

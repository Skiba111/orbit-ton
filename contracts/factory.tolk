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
            throw_unless(ERROR_INSUFFICIENT_FU
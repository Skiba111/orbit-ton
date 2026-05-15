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
//     ref3: addresses          — service_addr + fee_collector + protocol_fee_collector
//
// subscriber_info dict design:
//   Key:   subscriber_addr.hash() — 256 bits
//   Value: sub_addr(addr_std, 267 bits) + ever_trial_used(1 bit)
//   Stored at first OP_SUBSCRIBE; updated on re-subscribe.
//   Provides deterministic subscription address lookup for OP_CHANGE_PLAN.

import "@stdlib/tvm-dicts"
import "../utils/errors.tolk"
import "../utils/ops.tolk"
import "../utils/math-safe.tolk"
import "../utils/protocol-config.tolk"
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
fun get_subscriber_info(subscriber_info: dict, subscriber_hash: int): (slice, int) {
    var (entry, found) = subscriber_info.uDictGet(256, subscriber_hash);
    if (!found) {
        var zero: slice = beginCell().storeUint(0, 2).endCell().beginParse();
        return (zero, 0);
    }
    var s:               slice = entry!;
    var sub_addr:        slice = s.loadAddress() as slice;
    var ever_trial_used: int   = s.loadUint(1);
    return (sub_addr, ever_trial_used);
}

// Returns true when sub_addr is addr_none (subscriber has never subscribed through us).
@inline
fun sub_addr_is_none(sub_addr: slice): bool {
    return sub_addr.preloadUint(2) == 0;
}

fun set_subscriber_info(
    subscriber_info: dict,
    subscriber_hash: int,
    sub_addr:        slice,
    ever_trial_used: int
): dict {
    var entry: slice = beginCell()
        .storeSlice(sub_addr)
        .storeUint(ever_trial_used, 1)
    .endCell().beginParse();
    subscriber_info.uDictSet(256, subscriber_hash, entry);
    return subscriber_info;
}

// ── Storage helpers ───────────────────────────────────────────────────────────

fun load_factory_storage(): (int, int, int, int, int, int, int, int, dict, dict, cell, slice, slice, slice) {
    var ds: slice = contract.getData().beginParse();
    var relayer_pubkey:  int  = ds.loadUint(256);
    var seqno:           int  = ds.loadUint(32);
    var paused:          int  = ds.loadUint(1);
    var plan_count:      int  = ds.loadUint(32);
    var fee_bps:         int  = ds.loadUint(16);
    var total_charges:   int  = ds.loadUint(64);
    var total_revenue:   int  = ds.loadCoins();
    var keeper_pool:     int  = ds.loadCoins();
    var plans:           dict = ds.loadDict();
    var subscriber_info: dict = ds.loadDict();
    var sub_code:        cell = ds.loadRef();
    var addr_ref:        slice = ds.loadRef().beginParse();
    var service_addr:           slice = addr_ref.loadAddress() as slice;
    var fee_collector:          slice = addr_ref.loadAddress() as slice;
    var protocol_fee_collector: slice = addr_ref.loadAddress() as slice;
    return (relayer_pubkey, seqno, paused, plan_count, fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code,
            service_addr, fee_collector, protocol_fee_collector);
}

fun save_factory_storage(
    relayer_pubkey: int, seqno: int, paused: int, plan_count: int, fee_bps: int,
    total_charges: int, total_revenue: int, keeper_pool: int,
    plans: dict, subscriber_info: dict, sub_code: cell,
    service_addr: slice, fee_collector: slice, protocol_fee_collector: slice
) {
    contract.setData(
        beginCell()
            .storeUint(relayer_pubkey,  256)
            .storeUint(seqno,            32)
            .storeUint(paused,            1)
            .storeUint(plan_count,       32)
            .storeUint(fee_bps,          16)
            .storeUint(total_charges,    64)
            .storeCoins(total_revenue)
            .storeCoins(keeper_pool)
            .storeDict(plans)
            .storeDict(subscriber_info)
            .storeRef(sub_code)
            .storeRef(
                beginCell()
                    .storeSlice(service_addr)
                    .storeSlice(fee_collector)
                    .storeSlice(protocol_fee_collector)
                .endCell()
            )
        .endCell()
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
    protocol_fee_collector: slice,  // ORBIT-controlled; passed from Factory storage
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
        relayer_pubkey,
        protocol_fee_collector    // ORBIT protocol address — baked in, cannot be changed by service
    );

    return beginCell()
        .storeUint(6, 5)   // StateInit TL-B: split_depth=0, special=0, code=1, data=1, library=0
        .storeRef(sub_code)
        .storeRef(state_data)
    .endCell();
}

// Computes addr_std = workchain:SHA256(StateInit).
fun compute_contract_addr(state_init: cell): slice {
    var state_hash: int = state_init.hash();
    return beginCell()
        .storeUint(4, 3)    // addr_std tag: 0b100 (no anycast)
        .storeInt(0, 8)     // workchain = 0
        .storeUint(state_hash, 256)
    .endCell().beginParse();
}

// Builds OP_APPLY_PLAN body sent by factory to a subscription contract.
fun build_apply_plan_body(
    plan_id: int, price: int, period: int, trial_period: int
): cell {
    return beginCell()
        .storeUint(OP_APPLY_PLAN, 32)
        .storeUint(0, 64)
        .storeUint(plan_id, 32)
        .storeCoins(price)
        .storeUint(period, 32)
        .storeUint(trial_period, 32)
    .endCell();
}

// ── Internal message handler ──────────────────────────────────────────────────

fun onInternalMessage(my_balance: int, msg_value: int, in_msg_full: cell, in_msg_body: slice) {
    if (in_msg_body.isEnd()) { return; } // accept plain TON deposits

    var cs: slice = in_msg_full.beginParse();
    var flags: int = cs.loadUint(4);
    if (flags & 1) { return; } // ignore all bounced messages

    var sender: slice = cs.loadAddress() as slice;
    var op: int = in_msg_body.loadUint(32);
    in_msg_body.loadUint(64); // query_id

    var (
        relayer_pubkey, seqno, paused, plan_count, fee_bps,
        total_charges, total_revenue, keeper_pool,
        plans, subscriber_info, sub_code, service_addr, fee_collector, protocol_fee_collector
    ) = load_factory_storage();

    // ── OP_SUBSCRIBE ──────────────────────────────────────────────────────────
    //
    // Body: plan_id(32) + payment_type(2) + [if JETTON: jetton_wallet(addr_std)]
    //
    // Minimum value check (Bug #4 fix): reject subscriptions that cannot fund
    // even one billing cycle — prevents deploying always-insolvent subscriptions.
    if (op == OP_SUBSCRIBE) {
        require_not_paused(paused);

        var plan_id:      int = in_msg_body.loadUint(32);
        var payment_type: int = in_msg_body.loadUint(2);
        assert((payment_type == PAYMENT_TON) | (payment_type == PAYMENT_JETTON), ERROR_INVALID_OP);

        // Read optional jetton_wallet (only present when payment_type == PAYMENT_JETTON)
        var subscriber_jetton_wallet: slice = beginCell().storeUint(0, 2).endCell().beginParse();
        if (payment_type == PAYMENT_JETTON) {
            subscriber_jetton_wallet = in_msg_body.loadAddress() as slice;
        }

        var (price, period, trial_period) = require_active_plan(plans, plan_id);

        // Enforce minimum deposit: at least one billing cycle + reserve + gas.
        // For Jetton subscriptions, the TON value only covers gas/rent — no price check.
        if (payment_type == PAYMENT_TON) {
            var min_value: int = safe_add(safe_add(price, STORAGE_RESERVE), FACTORY_DEPLOY_GAS);
            assert(msg_value >= min_value, ERROR_INSUFFICIENT_FUNDS);
        } else {
            assert(msg_value >= safe_add(STORAGE_RESERVE, FACTORY_DEPLOY_GAS), ERROR_INSUFFICIENT_FUNDS);
        }

        var sender_hash:  int = sender.hash();
        var (_, ever_trial_used) = get_subscriber_info(subscriber_info, sender_hash);

        var my_addr: slice = contract.getAddress() as slice;
        var init_state: cell = build_sub_init(
            sender, plan_id, price, period, trial_period,
            ever_trial_used,      // trial_used at this subscribe time
            payment_type,
            subscriber_jetton_wallet,
            service_addr, fee_collector, fee_bps,
            relayer_pubkey, my_addr, protocol_fee_collector, sub_code
        );
        var sub_addr: slice = compute_contract_addr(init_state);

        var deposit: int = safe_sub(msg_value, FACTORY_DEPLOY_GAS);

        var msg: cell = beginCell()
            .storeUint(0x18, 6)
            .storeSlice(sub_addr)
            .storeCoins(deposit)
            .storeUint(6, 108)  // 105 zeros + init_present(1) + init_ref(1) + no_body(0)
            .storeRef(init_state)
        .endCell();
        sendRawMessage(msg, 1);

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
            plans, subscriber_info, sub_code, service_addr, fee_collector, protocol_fee_collector
        );
        return;
    }

    // ── OP_ADD_PLAN ───────────────────────────────────────────────────────────
    if (op == OP_ADD_PLAN) {
        require_owner(sender, service_addr);
        var new_price:        int = in_msg_body.loadCoins();
        var new_period:       int = in_msg_body.loadUint(32);
        var new_trial_period: int = in_msg_body.loadUint(32);
        var new_name_hash:    int = in_msg_body.loadUint(256);

        validate_amount(new_price);
        validate_period(new_period);

        plans = set_plan(plans, plan_count, new_price, new_period, new_trial_period, new_name_hash);
        save_factory_storage(
            relayer_pubkey, seqno, paused, plan_count + 1, fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector, protocol_fee_collector
        );
        return;
    }

    // ── OP_DEACTIVATE_PLAN ────────────────────────────────────────────────────
    if (op == OP_DEACTIVATE_PLAN) {
        require_owner(sender, service_addr);
        var target_plan_id: int = in_msg_body.loadUint(32);
        plans = deactivate_plan(plans, target_plan_id);
        save_factory_storage(
            relayer_pubkey, seqno, paused, plan_count, fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector, protocol_fee_collector
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
        var new_plan_id: int = in_msg_body.loadUint(32);
        var (new_price, new_period, new_trial_period) = require_active_plan(plans, new_plan_id);

        var sender_hash: int = sender.hash();
        var (sub_addr, _) = get_subscriber_info(subscriber_info, sender_hash);

        // Subscriber must have an existing subscription recorded by this factory
        assert(!sub_addr_is_none(sub_addr), ERROR_NOT_FOUND);

        var body: cell = build_apply_plan_body(new_plan_id, new_price, new_period, new_trial_period);
        var fwd_msg: cell = beginCell()
            .storeUint(0x18, 6)
            .storeSlice(sub_addr)
            .storeCoins(FACTORY_DEPLOY_GAS)  // 0.05 TON for OP_APPLY_PLAN gas (with safety margin)
            .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
            .storeRef(body)
        .endCell();
        sendRawMessage(fwd_msg, 0);
        return;
    }

    // ── OP_CHARGE_NOTIFICATION ────────────────────────────────────────────────
    // Subscription notifies us after each successful charge.
    // Auth: sender must match the sub_addr stored for notif_sub_addr in
    // subscriber_info — prevents anyone from spoofing this op to drain keeper_pool.
    if (op == OP_CHARGE_NOTIFICATION) {
        var notif_plan_id:  int   = in_msg_body.loadUint(32);
        var notif_amount:   int   = in_msg_body.loadCoins();
        var notif_sub_addr: slice = in_msg_body.loadAddress() as slice;
        var has_keeper:     int   = in_msg_body.loadUint(1);

        // Verify sender is the known subscription for notif_sub_addr
        var sub_hash: int = notif_sub_addr.hash();
        var (stored_sub_addr, _) = get_subscriber_info(subscriber_info, sub_hash);
        assert((!sub_addr_is_none(stored_sub_addr)) && addr_equal(sender, stored_sub_addr), ERROR_WRONG_SENDER);

        var new_keeper_pool: int = keeper_pool;
        if (has_keeper) {
            var keeper_wallet: slice = in_msg_body.loadAddress() as slice;
            // Pay bonus from pool if funded; skip silently if pool empty
            if (new_keeper_pool >= KEEPER_REWARD) {
                new_keeper_pool = safe_sub(new_keeper_pool, KEEPER_REWARD);
                var reward_msg: cell = beginCell()
                    .storeUint(0x10, 6)  // non-bounceable
                    .storeSlice(keeper_wallet)
                    .storeCoins(KEEPER_REWARD)
                    .storeUint(0, 107)
                .endCell();
                sendRawMessage(reward_msg, 0);
            }
        }

        save_factory_storage(
            relayer_pubkey, seqno, paused, plan_count, fee_bps,
            total_charges + 1, safe_add(total_revenue, notif_amount), new_keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector, protocol_fee_collector
        );
        return;
    }

    // ── OP_FUND_KEEPER_POOL ───────────────────────────────────────────────────
    // Service pre-funds the keeper reward pool.  Any msg_value above minimum
    // is added to keeper_pool.  No auth — anyone can fund the pool.
    if (op == OP_FUND_KEEPER_POOL) {
        // Require at least 0.005 TON above the handling floor to avoid safe_sub underflow
        assert(msg_value > 5000000, ERROR_INSUFFICIENT_FUNDS);
        var contribution: int = safe_sub(msg_value, 5000000); // deduct 0.005 TON msg handling gas
        if (contribution > 0) {
            save_factory_storage(
                relayer_pubkey, seqno, paused, plan_count, fee_bps,
                total_charges, total_revenue, safe_add(keeper_pool, contribution),
                plans, subscriber_info, sub_code, service_addr, fee_collector, protocol_fee_collector
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
            plans, subscriber_info, sub_code, service_addr, fee_collector, protocol_fee_collector
        );
        return;
    }

    if (op == OP_FACTORY_RESUME) {
        require_owner(sender, service_addr);
        save_factory_storage(
            relayer_pubkey, seqno, 0, plan_count, fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector, protocol_fee_collector
        );
        return;
    }

    // ── OP_UPDATE_FEE_BPS ─────────────────────────────────────────────────────
    // Updates the protocol fee for NEW subscriptions only.
    // Existing subscriptions snapshot fee_bps at deploy time and are unaffected.
    if (op == OP_UPDATE_FEE_BPS) {
        require_owner(sender, service_addr);
        var new_fee_bps: int = in_msg_body.loadUint(16);
        validate_fee_bps(new_fee_bps);
        save_factory_storage(
            relayer_pubkey, seqno, paused, plan_count, new_fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector, protocol_fee_collector
        );
        return;
    }

    // ── OP_UPDATE_PROTOCOL_COLLECTOR ─────────────────────────────────────────
    // Rotates the ORBIT protocol fee collection address for NEW subscriptions.
    // Auth: only the current protocol_fee_collector can call this — no key needed,
    // just a message from your wallet.  Existing subscriptions keep their stored
    // address (which you still own); only future Factory.sendSubscribe() calls
    // will bake in the new address.
    if (op == OP_UPDATE_PROTOCOL_COLLECTOR) {
        assert(addr_equal(sender, protocol_fee_collector), ERROR_WRONG_SENDER);
        var new_collector: slice = in_msg_body.loadAddress() as slice;
        save_factory_storage(
            relayer_pubkey, seqno, paused, plan_count, fee_bps,
            total_charges, total_revenue, keeper_pool,
            plans, subscriber_info, sub_code, service_addr, fee_collector, new_collector
        );
        return;
    }

    // ── OP_FACTORY_WITHDRAW ───────────────────────────────────────────────────
    if (op == OP_FACTORY_WITHDRAW) {
        require_owner(sender, service_addr);

        var balance:   int = contract.getOriginalBalance();
        var available: int = safe_sub(balance, safe_add(FACTORY_RESERVE, keeper_pool));
        assert(available > 0, ERROR_INSUFFICIENT_FUNDS);

        reserveToncoinsOnBalance(safe_add(FACTORY_RESERVE, keeper_pool), 0);

        var msg: cell = beginCell()
            .storeUint(0x10, 6)
            .storeSlice(service_addr)
            .storeCoins(0)
            .storeUint(0, 107)
        .endCell();
        sendRawMessage(msg, 128);
        return;
    }

    throw ERROR_INVALID_OP;
}

// ── Getters ───────────────────────────────────────────────────────────────────

get fun get_plan_count(): int {
    var (_, _, _, plan_count, _, _, _, _, _, _, _, _, _, _) = load_factory_storage();
    return plan_count;
}

get fun get_plan_data(plan_id: int): (int, int, int, int, int) {
    var (_, _, _, _, _, _, _, _, plans, _, _, _, _, _) = load_factory_storage();
    var (price, period, trial_period, active, name_hash) = unpack_plan(get_plan(plans, plan_id));
    return (price, period, trial_period, active, name_hash);
}

get fun is_factory_paused(): int {
    var (_, _, paused, _, _, _, _, _, _, _, _, _, _, _) = load_factory_storage();
    return paused;
}

get fun get_subscription_code(): cell {
    var (_, _, _, _, _, _, _, _, _, _, sub_code, _, _, _) = load_factory_storage();
    return sub_code;
}

get fun get_relayer_pubkey(): int {
    var (relayer_pubkey, _, _, _, _, _, _, _, _, _, _, _, _, _) = load_factory_storage();
    return relayer_pubkey;
}

get fun get_total_charges(): int {
    var (_, _, _, _, _, total_charges, _, _, _, _, _, _, _, _) = load_factory_storage();
    return total_charges;
}

get fun get_total_revenue(): int {
    var (_, _, _, _, _, _, total_revenue, _, _, _, _, _, _, _) = load_factory_storage();
    return total_revenue;
}

get fun get_keeper_pool(): int {
    var (_, _, _, _, _, _, _, keeper_pool, _, _, _, _, _, _) = load_factory_storage();
    return keeper_pool;
}

get fun get_fee_bps(): int {
    var (_, _, _, _, fee_bps, _, _, _, _, _, _, _, _, _) = load_factory_storage();
    return fee_bps;
}

get fun get_stored_protocol_fee_collector(): slice {
    var (_, _, _, _, _, _, _, _, _, _, _, _, _, protocol_fee_collector) = load_factory_storage();
    return protocol_fee_collector;
}

get fun get_protocol_fee_bps(): int {
    return PROTOCOL_FEE_BPS;
}

get fun get_version(): int {
    return 2; // bumped: protocol_fee_collector added to storage
}

// Returns the on-chain subscription address for a given subscriber and plan.
// If the subscriber has already subscribed through this factory, returns the
// stored address (canonical).  Otherwise computes it from the plan snapshot.
//
// payment_type: PAYMENT_TON(1) or PAYMENT_JETTON(2).  Must match what the subscriber
// will pass to OP_SUBSCRIBE.  The payment_type is baked into the init_state cell
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
        plans, subscriber_info, sub_code, service_addr, fee_collector, protocol_fee_collector
    ) = load_factory_storage();

    var sub_hash: int = subscriber_addr.hash();
    var (stored_addr, _) = get_subscriber_info(subscriber_info, sub_hash);

    if (!sub_addr_is_none(stored_addr)) {
        return stored_addr; // canonical address if already subscribed
    }

    // Subscriber has not yet subscribed — compute expected address (trial_used=0)
    var (price, period, trial_period, _, _) = unpack_plan(get_plan(plans, plan_id));
    var my_addr: slice = contract.getAddress() as slice;
    var init_state: cell = build_sub_init(
        subscriber_addr, plan_id, price, period, trial_period,
        0,                       // trial_used = 0 for first subscribe
        payment_type,
        subscriber_jetton_wallet,
        service_addr, fee_collector, fee_bps,
        relayer_pubkey, my_addr, protocol_fee_collector, sub_code
    );
    return compute_contract_addr(init_state);
}

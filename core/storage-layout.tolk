// Storage layout for the Subscription contract.
//
// Root cell bits (fixed):
//   [32]  seqno                — external message replay counter
//   [4]   status               — subscription state machine
//   [2]   payment_type         — TON(1) or JETTON(2)
//   [1]   charging_in_progress — double-charge guard (Jetton async)
//   [1]   paused_global        — emergency pause flag
//   [1]   keeper_mode          — if 1, skip sig check; any keeper may charge
//   [8]   retry_count          — failed charge counter
//   [32]  period               — billing interval in seconds (snapshot)
//   [32]  next_billing_time    — unix timestamp of next charge
//   [32]  grace_end_time       — grace window end (0 = not in grace)
//   [32]  plan_id              — plan snapshot at subscription time
//   [32]  max_periods          — 0 = unlimited; >0 = fixed-term subscription
//   [32]  periods_charged      — number of successfully completed billing cycles
//   [var] amount               — billing amount per cycle (coins, snapshot)
//   [var] deposit              — subscriber's pre-funded balance (coins)
//   [var] storage_reserve      — minimum balance kept for rent (coins)
//   [16]  fee_bps              — service fee in basis points (0-1000); protocol fee is PROTOCOL_FEE_BPS=150 in protocol-config.tolk
//   [32]  trial_period         — 0 = no trial
//
// Ref 0 — addresses (801 bits, fits in 1023):
//   service_addr     (267 bits)
//   subscriber_addr  (267 bits)
//   factory_addr     (267 bits)
//
// Ref 1 — billing config (790 bits, fits in 1023):
//   fee_collector    (267 bits)
//   jetton_wallet    (267 bits)
//   relayer_pubkey   (256 bits)
//
// Ref 2 — protocol fee collector (267 bits):
//   protocol_fee_collector (267 bits) — ORBIT's fee collection address.
//   Passed by the Factory at Subscription deploy time (from Factory storage).
//   The Factory receives this address as a deploy-time parameter; it is NOT
//   taken from PROTOCOL_FEE_COLLECTOR_HASH at runtime (that constant is a
//   reference only). Cannot be changed by the service; only the ORBIT team
//   can rotate it via OP_UPDATE_PROTOCOL_COLLECTOR on the Factory (new subs only).
//
// relayer_pubkey: Ed25519 public key; 0 = key-less (keeper_mode only).
// factory_addr: address of the deploying Factory; used to authenticate
//   OP_APPLY_PLAN messages (plan changes must be authorised by the factory).

import "../utils/errors.tolk"
import "../core/subscription-state.tolk"

const STORAGE_RESERVE: int = 50000000; // 0.05 TON — always kept for rent

// ── Serialisation ─────────────────────────────────────────────────────────────

fun pack_subscription(
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
    protocol_fee_collector: slice   // ORBIT protocol address — hardcoded at deploy
): cell {
    return beginCell()
        .storeUint(seqno,               32)
        .storeUint(status,               4)
        .storeUint(payment_type,         2)
        .storeUint(charging_in_progress, 1)
        .storeUint(paused_global,        1)
        .storeUint(keeper_mode,          1)
        .storeUint(retry_count,          8)
        .storeUint(period,              32)
        .storeUint(next_billing_time,   32)
        .storeUint(grace_end_time,      32)
        .storeUint(plan_id,             32)
        .storeUint(max_periods,         32)
        .storeUint(periods_charged,     32)
        .storeCoins(amount)
        .storeCoins(deposit)
        .storeCoins(storage_reserve)
        .storeUint(fee_bps,             16)
        .storeUint(trial_period,        32)
        .storeRef(
            beginCell()
                .storeSlice(service_addr)
                .storeSlice(subscriber_addr)
                .storeSlice(factory_addr)
            .endCell()
        )
        .storeRef(
            beginCell()
                .storeSlice(fee_collector)
                .storeSlice(jetton_wallet)
                .storeUint(relayer_pubkey, 256)
            .endCell()
        )
        .storeRef(
            beginCell()
                .storeSlice(protocol_fee_collector)
            .endCell()
        )
    .endCell();
}

// ── Deserialisation ───────────────────────────────────────────────────────────

fun unpack_subscription(raw: cell): (
    int, int, int, int, int, int,                  // seqno status payment_type charging paused keeper_mode
    int, int, int, int, int, int, int,             // retry period next_billing grace_end plan_id max_periods periods_charged
    int, int, int, int, int,                       // amount deposit storage_reserve fee_bps trial_period
    slice, slice, slice, slice, slice, int, slice  // service subscriber factory fee_collector jetton_wallet relayer_pubkey protocol_fee_collector
) {
    var ds: slice = raw.beginParse();

    var seqno:                int = ds.loadUint(32);
    var status:               int = ds.loadUint(4);
    var payment_type:         int = ds.loadUint(2);
    var charging_in_progress: int = ds.loadUint(1);
    var paused_global:        int = ds.loadUint(1);
    var keeper_mode:          int = ds.loadUint(1);
    var retry_count:          int = ds.loadUint(8);
    var period:               int = ds.loadUint(32);
    var next_billing_time:    int = ds.loadUint(32);
    var grace_end_time:       int = ds.loadUint(32);
    var plan_id:              int = ds.loadUint(32);
    var max_periods:          int = ds.loadUint(32);
    var periods_charged:      int = ds.loadUint(32);
    var amount:               int = ds.loadCoins();
    var deposit:              int = ds.loadCoins();
    var storage_reserve:      int = ds.loadCoins();
    var fee_bps:              int = ds.loadUint(16);
    var trial_period:         int = ds.loadUint(32);

    var ref0: slice = ds.loadRef().beginParse();
    var service_addr:    slice = ref0.loadAddress() as slice;
    var subscriber_addr: slice = ref0.loadAddress() as slice;
    var factory_addr:    slice = ref0.loadAddress() as slice;

    var ref1: slice = ds.loadRef().beginParse();
    var fee_collector:   slice = ref1.loadAddress() as slice;
    var jetton_wallet:   slice = ref1.loadAddress() as slice;
    var relayer_pubkey:  int   = ref1.loadUint(256);

    var ref2: slice = ds.loadRef().beginParse();
    var protocol_fee_collector: slice = ref2.loadAddress() as slice;

    return (
        seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
        retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
        amount, deposit, storage_reserve, fee_bps, trial_period,
        service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet,
        relayer_pubkey, protocol_fee_collector
    );
}

// Convenience wrappers for the contract entry points.
fun load_storage(): (
    int, int, int, int, int, int,
    int, int, int, int, int, int, int,
    int, int, int, int, int,
    slice, slice, slice, slice, slice, int, slice
) {
    return unpack_subscription(contract.getData());
}

fun save_storage(
    seqno: int, status: int, payment_type: int,
    charging_in_progress: int, paused_global: int, keeper_mode: int,
    retry_count: int, period: int, next_billing_time: int,
    grace_end_time: int, plan_id: int, max_periods: int, periods_charged: int,
    amount: int, deposit: int, storage_reserve: int,
    fee_bps: int, trial_period: int,
    service_addr: slice, subscriber_addr: slice, factory_addr: slice,
    fee_collector: slice, jetton_wallet: slice,
    relayer_pubkey: int, protocol_fee_collector: slice
) {
    contract.setData(pack_subscription(
        seqno, status, payment_type,
        charging_in_progress, paused_global, keeper_mode,
        retry_count, period, next_billing_time,
        grace_end_time, plan_id, max_periods, periods_charged,
        amount, deposit, storage_reserve,
        fee_bps, trial_period,
        service_addr, subscriber_addr, factory_addr,
        fee_collector, jetton_wallet,
        relayer_pubkey, protocol_fee_collector
    ));
}

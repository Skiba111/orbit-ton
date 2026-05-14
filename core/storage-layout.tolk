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
//   [16]  fee_bps              — protocol fee in basis points (0-1000)
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
    relayer_pubkey:         int
): cell {
    return begin_cell()
        .store_uint(seqno,               32)
        .store_uint(status,               4)
        .store_uint(payment_type,         2)
        .store_uint(charging_in_progress, 1)
        .store_uint(paused_global,        1)
        .store_uint(keeper_mode,          1)
        .store_uint(retry_count,          8)
        .store_uint(period,              32)
        .store_uint(next_billing_time,   32)
        .store_uint(grace_end_time,      32)
        .store_uint(plan_id,             32)
        .store_uint(max_periods,         32)
        .store_uint(periods_charged,     32)
        .store_coins(amount)
        .store_coins(deposit)
        .store_coins(storage_reserve)
        .store_uint(fee_bps,             16)
        .store_uint(trial_period,        32)
        .store_ref(
            begin_cell()
                .store_slice(service_addr)
                .store_slice(subscriber_addr)
                .store_slice(factory_addr)
            .end_cell()
        )
        .store_ref(
            begin_cell()
                .store_slice(fee_collector)
                .store_slice(jetton_wallet)
                .store_uint(relayer_pubkey, 256)
            .end_cell()
        )
    .end_cell();
}

// ── Deserialisation ───────────────────────────────────────────────────────────

fun unpack_subscription(raw: cell): (
    int, int, int, int, int, int,          // seqno status payment_type charging paused keeper_mode
    int, int, int, int, int, int, int,     // retry period next_billing grace_end plan_id max_periods periods_charged
    int, int, int, int, int,               // amount deposit storage_reserve fee_bps trial_period
    slice, slice, slice, slice, slice, int // service subscriber factory fee_collector jetton_wallet relayer_pubkey
) {
    var ds: slice = raw.begin_parse();

    var seqno:                int = ds.load_uint(32);
    var status:               int = ds.load_uint(4);
    var payment_type:         int = ds.load_uint(2);
    var charging_in_progress: int = ds.load_uint(1);
    var paused_global:        int = ds.load_uint(1);
    var keeper_mode:          int = ds.load_uint(1);
    var retry_count:          int = ds.load_uint(8);
    var period:               int = ds.load_uint(32);
    var next_billing_time:    int = ds.load_uint(32);
    var grace_end_time:       int = ds.load_uint(32);
    var plan_id:              int = ds.load_uint(32);
    var max_periods:          int = ds.load_uint(32);
    var periods_charged:      int = ds.load_uint(32);
    var amount:               int = ds.load_coins();
    var deposit:              int = ds.load_coins();
    var storage_reserve:      int = ds.load_coins();
    var fee_bps:              int = ds.load_uint(16);
    var trial_period:         int = ds.load_uint(32);

    var ref0: slice = ds.load_ref().begin_parse();
    var service_addr:    slice = ref0.load_msg_addr();
    var subscriber_addr: slice = ref0.load_msg_addr();
    var factory_addr:    slice = ref0.load_msg_addr();

    var ref1: slice = ds.load_ref().begin_parse();
    var fee_collector:   slice = ref1.load_msg_addr();
    var jetton_wallet:   slice = ref1.load_msg_addr();
    var relayer_pubkey:  int   = ref1.load_uint(256);

    return (
        seqno, status, payment_type, charging_in_progress, paused_global, keeper_mode,
        retry_count, period, next_billing_time, grace_end_time, plan_id, max_periods, periods_charged,
        amount, deposit, storage_reserve, fee_bps, trial_period,
        service_addr, subscriber_addr, factory_addr, fee_collector, jetton_wallet, relayer_pubkey
    );
}

// Convenience wrappers for the contract entry points.
fun load_storage(): (
    int, int, int, int, int, int,
    int, int, int, int, int, int, int,
    int, int, int, int, int,
    slice, slice, slice, slice, slice, int
) {
    return unpack_subscription(get_data());
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
    relayer_pubkey: int
) {
    set_data(pack_subscription(
        seqno, status, payment_type,
        charging_in_progress, paused_global, keeper_mode,
        retry_count, period, next_billing_time,
        grace_end_time, plan_id, max_periods, periods_charged,
        amount, deposit, storage_reserve,
        fee_bps, trial_period,
        service_addr, subscriber_addr, factory_addr,
        fee_collector, jetton_wallet,
        relayer_pubkey
    ));
}

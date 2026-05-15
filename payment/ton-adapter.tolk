// Native TON payment adapter.
//
// Builds and sends internal messages carrying billing payments.
// All amounts are in nanotons.  Gas costs are explicitly added so the
// receiving contract always has enough to run.

import "../utils/ops.tolk"
import "../utils/math-safe.tolk"

// Gas attached to every outgoing billing message (≈ 0.01 TON).
// The service contract receives exactly net_amount + PAYMENT_GAS and can
// refund the gas difference via OP_EXCESSES if desired.
const PAYMENT_GAS: int = 10000000;

// Minimum refund worth sending (avoid dust messages to subscriber).
const MIN_REFUND:  int = 5000000; // 0.005 TON

// ── Payment body ──────────────────────────────────────────────────────────────

fun build_charge_body(subscriber_addr: slice, plan_id: int): cell {
    return beginCell()
        .storeUint(OP_CHARGE_INTERNAL, 32)
        .storeUint(0, 64)               // query_id reserved
        .storeSlice(subscriber_addr)
        .storeUint(plan_id, 32)
    .endCell();
}

// ── Send payment to service ───────────────────────────────────────────────────

fun send_payment_ton(
    service_addr:    slice,
    net_amount:      int,
    subscriber_addr: slice,
    plan_id:         int
) {
    var body: cell = build_charge_body(subscriber_addr, plan_id);
    var msg: cell = beginCell()
        .storeUint(0x18, 6)   // bounceable — so bounces come back to us
        .storeSlice(service_addr)
        .storeCoins(net_amount + PAYMENT_GAS)
        .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .storeRef(body)
    .endCell();

    sendRawMessage(msg, 1); // mode 1 = pay forwarding fees from balance
}

// ── Refund to subscriber ──────────────────────────────────────────────────────

fun send_refund(subscriber_addr: slice, deposit: int, storage_reserve: int) {
    var refund_amount: int = safe_sub(deposit, storage_reserve);
    if (refund_amount < MIN_REFUND) { return; } // don't send dust

    reserveToncoinsOnBalance(storage_reserve, 0); // keep minimum for rent

    var body: cell = beginCell()
        .storeUint(OP_REFUND, 32)
        .storeUint(0, 64)
    .endCell();

    var msg: cell = beginCell()
        .storeUint(0x10, 6)   // non-bounceable refund
        .storeSlice(subscriber_addr)
        .storeCoins(0)        // replaced by TVM with remaining balance (mode 128)
        .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .storeRef(body)
    .endCell();

    // Mode 128: send all remaining balance after RAWRESERVE so gas consumed
    // during external-message processing doesn't cause action-37 rollback.
    sendRawMessage(msg, 128);
}

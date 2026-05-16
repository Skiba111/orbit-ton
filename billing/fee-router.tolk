// Fee router — calculates and dispatches protocol and service fees.
//
// Two fees are deducted from every billing cycle:
//
//   service_fee   = amount * fee_bps / 10000   → goes to service's fee_collector
//   protocol_fee  = amount * PROTOCOL_FEE_BPS / 10000 → goes to ORBIT protocol address
//
// Both are deducted from the gross billing amount; the service receives the remainder.
// PROTOCOL_FEE_BPS is a hardcoded constant in the Subscription bytecode — the service
// cannot change it without recompiling, which produces non-ORBIT bytecode.
//
// Fee cap: MAX_FEE_BPS = 1000 (10%) covers only the service fee.
//
// Bounce safety: both fee messages are bounceable. If fee_collector is unreachable,
// OP_FEE_PAYMENT bounces back and restores the amount to deposit.
// If protocol_fee_collector is unreachable, OP_PROTOCOL_FEE_PAYMENT bounces back
// and the deposit is similarly restored.

import "../utils/math-safe.tolk"
import "../utils/ops.tolk"
import "../utils/protocol-config.tolk"
import "../utils/errors.tolk"

// Minimum TON to attach when forwarding a fee message (covers gas on receipt).
const FEE_MSG_GAS: int = 10000000; // 0.01 TON

// ── Fee split ─────────────────────────────────────────────────────────────────
//
// Returns (net_amount, service_fee, protocol_fee).
//   net_amount    = amount the service actually receives
//   service_fee   = configurable cut for the service's fee_collector
//   protocol_fee  = hardcoded 0.2% for ORBIT protocol
@inline
fun split_fee(gross: int, fee_bps: int): (int, int, int) {
    // Belt-and-suspenders: fee_bps should have been validated at plan creation,
    // but guard here too so execute_charge never produces a negative net_amount.
    assert(fee_bps <= MAX_FEE_BPS, ERROR_INVALID_AMOUNT);
    var service_fee:  int = bps_of(gross, fee_bps);
    var protocol_fee: int = bps_of(gross, PROTOCOL_FEE_BPS);
    var net:          int = safe_sub(safe_sub(gross, service_fee), protocol_fee);
    return (net, service_fee, protocol_fee);
}

// ── Message body builders ─────────────────────────────────────────────────────
//
// IMPORTANT: fee_amount is placed BEFORE subscriber_addr so that it lands
// within the first 256 bits of the body.  TON truncates bounce message bodies
// to 256 bits; the subscription bounce handler reads fee_amount from the bounce
// to restore the deposit.  Layout: OP(32) + query_id(64) + fee_amount(≤124) = ≤220 bits.
fun build_fee_body(subscriber_addr: slice, plan_id: int, fee_amount: int): cell {
    return beginCell()
        .storeUint(OP_FEE_PAYMENT, 32)
        .storeUint(0, 64)
        .storeCoins(fee_amount)     // ← within bounce window
        .storeUint(plan_id, 32)
        .storeSlice(subscriber_addr)
    .endCell();
}

fun build_protocol_fee_body(subscriber_addr: slice, plan_id: int, fee_amount: int): cell {
    return beginCell()
        .storeUint(OP_PROTOCOL_FEE_PAYMENT, 32)
        .storeUint(0, 64)
        .storeCoins(fee_amount)     // ← within bounce window
        .storeUint(plan_id, 32)
        .storeSlice(subscriber_addr)
    .endCell();
}

// ── Dispatchers ───────────────────────────────────────────────────────────────

fun send_fee(
    fee_collector:   slice,
    fee_amount:      int,
    subscriber_addr: slice,
    plan_id:         int
) {
    if (fee_amount == 0) { return; }
    var body: cell = build_fee_body(subscriber_addr, plan_id, fee_amount);
    var msg: cell = beginCell()
        .storeUint(0x18, 6)   // bounceable
        .storeSlice(fee_collector)
        .storeCoins(fee_amount + FEE_MSG_GAS)
        .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .storeRef(body)
    .endCell();
    sendRawMessage(msg, 0);
}

// Sends the ORBIT protocol fee to the hardcoded protocol_fee_collector address.
// Uses the stored address (baked in at deploy from PROTOCOL_FEE_COLLECTOR_HASH).
// Message is bounceable so the deposit is restored if the collector is unreachable.
fun send_protocol_fee(
    protocol_fee_collector: slice,
    protocol_fee:           int,
    subscriber_addr:        slice,
    plan_id:                int
) {
    if (protocol_fee == 0) { return; }
    var body: cell = build_protocol_fee_body(subscriber_addr, plan_id, protocol_fee);
    var msg: cell = beginCell()
        .storeUint(0x18, 6)   // bounceable
        .storeSlice(protocol_fee_collector)
        .storeCoins(protocol_fee + FEE_MSG_GAS)
        .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .storeRef(body)
    .endCell();
    sendRawMessage(msg, 0);
}

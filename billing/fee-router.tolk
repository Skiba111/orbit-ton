// Fee router — calculates and dispatches protocol fee.
//
// The fee_collector address is embedded in each subscription contract at
// deploy time (as a constructor argument from the factory).  It is NOT
// a mutable parameter, so a service operator cannot redirect fees to
// themselves post-deploy.  Full auditability: grep for fee_collector in
// storage-layout.tolk to find the single storage slot.
//
// Fee cap: MAX_FEE_BPS = 1000 (10%).  Enforced in math-safe.tolk.

import "../utils/math-safe.tolk"
import "../utils/ops.tolk"

// Minimum TON to attach when forwarding the fee message (covers gas on receipt).
const FEE_MSG_GAS: int = 10000000; // 0.01 TON

// Computes (net_amount, fee_amount) from a gross billing amount.
@inline
fun split_fee(gross: int, fee_bps: int): (int, int) {
    var fee: int = bps_of(gross, fee_bps);
    var net: int = safe_sub(gross, fee);
    return (net, fee);
}

// Builds the fee notification body sent to the fee_collector contract.
// The collector can use this data for off-chain analytics.
//
// IMPORTANT: fee_amount is placed BEFORE subscriber_addr so that it lands
// within the first 256 bits of the body.  TON truncates bounce message bodies
// to 256 bits; the subscription bounce handler reads fee_amount from the
// bounce to restore the deposit if the fee_collector is unreachable.
// Layout: OP(32) + query_id(64) + fee_amount(≤124) = ≤220 bits total — safe.
fun build_fee_body(subscriber_addr: slice, plan_id: int, fee_amount: int): cell {
    return begin_cell()
        .store_uint(OP_FEE_PAYMENT, 32)
        .store_uint(0, 64)           // query_id = 0 for fee messages
        .store_coins(fee_amount)     // ← before subscriber_addr; must stay within bounce window
        .store_uint(plan_id, 32)
        .store_slice(subscriber_addr)
    .end_cell();
}

// Dispatches the fee payment to the fee_collector.
// Uses SEND_MODE_REGULAR (mode 0) so an error on the fee message does NOT
// roll back the main payment — the service always gets paid even if the
// fee collector is unreachable.
fun send_fee(
    fee_collector: slice,
    fee_amount:    int,
    subscriber_addr: slice,
    plan_id:       int
) {
    if (fee_amount == 0) { return; }

    var body: cell = build_fee_body(subscriber_addr, plan_id, fee_amount);
    var msg: cell = begin_cell()
        .store_uint(0x18, 6)   // bounceable
        .store_slice(fee_collector)
        .store_coins(fee_amount + FEE_MSG_GAS)
        .store_uint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .store_ref(body)
    .end_cell();

    send_raw_message(msg, 0); // mode 0 = pay fees from contract balance
}

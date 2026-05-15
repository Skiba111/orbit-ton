// Jetton payment adapter (TEP-74 compliant).
//
// Jetton transfers in TON are asynchronous:
//   1. Contract sends OP_JETTON_TRANSFER to its own Jetton wallet.
//   2. The Jetton wallet routes funds and sends OP_JETTON_TRANSFER_NOTIFICATION
//      to the service's Jetton wallet, then OP_JETTON_EXCESSES back to us.
//   3. We handle OP_JETTON_EXCESSES as the "charge confirmed" signal and
//      clear charging_in_progress.
//
// Race condition protection (vuln 3):
//   charging_in_progress = 1 from the moment we fire the Jetton transfer
//   until we receive OP_JETTON_EXCESSES.  The flag is only cleared by a
//   confirmed OP_JETTON_EXCESSES originating from the known jetton_wallet.
//
// The contract must hold Jetton tokens in its own wallet
// (subscriber sends Jetton to this contract address to top up).

import "../utils/errors.tolk"
import "../utils/ops.tolk"
import "../utils/math-safe.tolk"

// Gas for Jetton transfer message (covers wallet computation on both sides).
const JETTON_TRANSFER_GAS:     int = 50000000;  // 0.05 TON
const JETTON_TRANSFER_FWD_GAS: int = 20000000;  // 0.02 TON forward gas to service

// ── Build OP_JETTON_TRANSFER body ─────────────────────────────────────────────
//
// forward_payload is forwarded to the destination alongside the Jetton tokens.
// It carries subscriber_addr + plan_id so services can match incoming Jettons
// to their subscriber's billing cycle.

fun build_jetton_transfer_body(
    query_id:        int,
    amount:          int,
    destination:     slice,
    response_dest:   slice,  // where to send OP_EXCESSES (= this contract)
    forward_payload: cell    // metadata forwarded to destination; never null for billing
): cell {
    return beginCell()
        .storeUint(OP_JETTON_TRANSFER, 32)
        .storeUint(query_id, 64)
        .storeCoins(amount)
        .storeSlice(destination)
        .storeSlice(response_dest)
        .storeUint(0, 1)               // custom_payload = null (not used by TEP-74)
        .storeCoins(JETTON_TRANSFER_FWD_GAS)
        .storeUint(1, 1)               // forward_payload present, stored as ref
        .storeRef(forward_payload)     // ← subscriber+plan metadata the service receives
    .endCell();
}

// ── Send Jetton to service (billing cycle) ────────────────────────────────────

fun send_jetton_payment(
    my_addr:         slice,  // this contract's address (receives OP_EXCESSES)
    jetton_wallet:   slice,  // this contract's Jetton wallet address
    service_addr:    slice,
    net_amount:      int,
    subscriber_addr: slice,
    plan_id:         int,
    query_id:        int
) {
    var fwd_payload: cell = beginCell()
        .storeUint(OP_CHARGE_INTERNAL, 32)
        .storeSlice(subscriber_addr)
        .storeUint(plan_id, 32)
    .endCell();

    var body: cell = build_jetton_transfer_body(
        query_id,
        net_amount,
        service_addr,
        my_addr,       // excesses come back here
        fwd_payload
    );

    var msg: cell = beginCell()
        .storeUint(0x18, 6)   // bounceable
        .storeSlice(jetton_wallet)
        .storeCoins(JETTON_TRANSFER_GAS)
        .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .storeRef(body)
    .endCell();

    sendRawMessage(msg, 1);
}

// ── Send Jetton refund to subscriber (on cancel) ──────────────────────────────
//
// Returns Jetton tokens from this contract's wallet back to the subscriber.
// Called instead of send_refund() when payment_type == PAYMENT_JETTON.

fun send_refund_jetton(
    jetton_wallet:   slice,
    subscriber_addr: slice,
    token_amount:    int,
    my_addr:         slice
) {
    if (token_amount == 0) { return; }

    var fwd_payload: cell = beginCell()
        .storeUint(OP_REFUND, 32)
        .storeUint(0, 64)
    .endCell();

    var body: cell = build_jetton_transfer_body(
        0,               // query_id = 0 for refunds
        token_amount,
        subscriber_addr, // tokens go back to subscriber
        subscriber_addr, // excesses also go to subscriber
        fwd_payload
    );

    var msg: cell = beginCell()
        .storeUint(0x18, 6)  // bounceable — if transfer fails, tokens stay here
        .storeSlice(jetton_wallet)
        .storeCoins(JETTON_TRANSFER_GAS)
        .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .storeRef(body)
    .endCell();

    sendRawMessage(msg, 1);
}

// ── Jetton deposit handling ───────────────────────────────────────────────────
//
// When subscriber sends Jetton to this contract, the Jetton wallet sends
// OP_JETTON_TRANSFER_NOTIFICATION with the amount and original sender.

fun handle_jetton_deposit_notification(in_msg_body: slice): int {
    // OP already consumed by caller
    in_msg_body.loadUint(64); // query_id
    var amount: int = in_msg_body.loadCoins();
    // Reject zero-amount notifications — a malicious Jetton wallet could send
    // amount=0 to trigger auto-learn without actually depositing tokens.
    assert(amount > 0, ERROR_INSUFFICIENT_FUNDS);
    return amount;
}

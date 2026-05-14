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
    return begin_cell()
        .store_uint(OP_JETTON_TRANSFER, 32)
        .store_uint(query_id, 64)
        .store_coins(amount)
        .store_slice(destination)
        .store_slice(response_dest)
        .store_uint(0, 1)               // custom_payload = null (not used by TEP-74)
        .store_coins(JETTON_TRANSFER_FWD_GAS)
        .store_uint(1, 1)               // forward_payload present, stored as ref
        .store_ref(forward_payload)     // ← subscriber+plan metadata the service receives
    .end_cell();
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
    var fwd_payload: cell = begin_cell()
        .store_uint(OP_CHARGE_INTERNAL, 32)
        .store_slice(subscriber_addr)
        .store_uint(plan_id, 32)
    .end_cell();

    var body: cell = build_jetton_transfer_body(
        query_id,
        net_amount,
        service_addr,
        my_addr,       // excesses come back here
        fwd_payload
    );

    var msg: cell = begin_cell()
        .store_uint(0x18, 6)   // bounceable
        .store_slice(jetton_wallet)
        .store_coins(JETTON_TRANSFER_GAS)
        .store_uint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .store_ref(body)
    .end_cell();

    send_raw_message(msg, 1);
}

// ── Send Jetton refund to subscriber (on cancel) ──────────────────────────────
//
// Returns Jetton tokens from this contract's wallet back to the subscriber.
// Called instead of send_refund() when payment_type == PAYMENT_JETTON.

fun send_re
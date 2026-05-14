// Fee Collector Contract
//
// Receives protocol fees from Subscription contracts, accumulates them,
// and allows the protocol owner to withdraw via a two-phase process:
//
//   Phase 1 — OP_COLLECT (external, signed):
//     Records the withdrawal intent (amount + destination) and sets
//     withdrawal_request_time = now().  Does NOT send funds yet.
//
//   Phase 2 — OP_CONFIRM_COLLECT (external, signed):
//     Executes after WITHDRAWAL_TIMELOCK_SEC (24 h) has elapsed.
//     Sends the previously requested amount to the previously requested dest.
//
// Timelock rationale:
//   A compromised owner key can only schedule a withdrawal, not execute it
//   immediately.  The 24 h window allows time to detect the compromise and
//   rotate the key before funds move.  The new key can cancel the pending
//   withdrawal by issuing a new OP_COLLECT with amount=0.
//
// Storage layout:
//   Root:
//     [256] owner_pubkey
//     [32]  seqno
//     [var] total_collected (coins)
//   Ref0 — pending withdrawal (all zeros = no pending):
//     [32]  withdrawal_request_time  (unix ts; 0 = no pending)
//     [var] withdrawal_amount        (coins; 0 = withdraw all available)
//     [addr] withdrawal_dest
//
// Security model:
//   - OP_FEE_PAYMENT is accepted from any address (no subscription registry).
//   - Both phase-1 and phase-2 messages require a valid Ed25519 signature.
//   - raw_reserve(COLLECTOR_RESERVE) enforced before every withdrawal send.

import "../utils/errors.tolk"
import "../utils/ops.tolk"
import "../utils/math-safe.tolk"
import "../access/role-manager.tolk"
import "../utils/time-oracle.tolk"

const COLLECTOR_RESERVE:        int = 100000000; // 0.1 TON — always kept for rent
const WITHDRAWAL_TIMELOCK_SEC:  int = 86400;     // 24 hours

// ── Storage ───────────────────────────────────────────────────────────────────

fun load_pending_withdrawal(raw: cell): (int, int, slice) {
    var s: slice = raw.begin_parse();
    var request_time: int   = s.load_uint(32);
    var amount:       int   = s.load_coins();
    var dest:         slice = s.load_msg_addr();
    return (request_time, amount, dest);
}

fun pack_pending_withdrawal(request_time: int, amount: int, dest: slice): cell {
    return begin_cell()
        .store_uint(request_time, 32)
        .store_coins(amount)
        .store_slice(dest)
    .end_cell();
}

fun load_collector_storage(): (int, int, int, cell) {
    var ds: slice = get_data().begin_parse();
    var owner_pubkey:    int  = ds.load_uint(256);
    var seqno:           int  = ds.load_uint(32);
    var total_collected: int  = ds.load_coins();
    var pending_cell:    cell = ds.load_ref();
    return (owner_pubkey, seqno, total_collected, pending_cell);
}

fun save_collector_storage(
    owner_pubkey: int, seqno: int, total_collected: int, pending_cell: cell
) {
    set_data(
        begin_cell()
            .store_uint(owner_pubkey, 256)
            .store_uint(seqno, 32)
            .store_coins(total_collected)
            .store_ref(pending_cell)
        .end_cell()
    );
}

// Builds a zeroed pending-withdrawal cell (no pending withdrawal).
fun empty_pending(): cell {
    var zero_addr: slice = begin_cell().store_uint(0, 2).end_cell().begin_parse();
    return pack_pending_withdrawal(0, 0, zero_addr);
}

// ── Internal message handler ──────────────────────────────────────────────────

fun recv_internal(my_balance: int, msg_value: int, in_msg_full: cell, in_msg_body: slice) {
    if (in_msg_body.slice_empty?()) { return; } // plain TON deposit accepted

    var cs: slice = in_msg_full.begin_parse();
    var flags: int = cs.load_uint(4);
    if (flags & 1) { return; }

    var op: int = in_msg_body.load_uint(32);

    if (op == OP_FEE_PAYMENT) {
        var (owner_pubkey, seqno, total_collected, pending_cell) = load_collector_storage();
        save_collector_storage(owner_pubkey, seqno, safe_add(total_collected, msg_value), pending_cell);
        return;
    }

    throw(ERROR_INVALID_OP);
}

// ── External message handler ──────────────────────────────────────────────────
//
// External layout (both ops):
//   [512] signature   — Ed25519(owner_privkey) over slice_hash(seqno ++ timestamp ++ op ++ payload)
//   [32]  seqno
//   [32]  timestamp   — must be fresh (within EXT_MSG_TTL)
//   [32]  op          — OP_COLLECT or OP_CONFIRM_COLLECT
//   payload:
//     OP_COLLECT:         amount(coins) + dest(addr)   — schedule withdrawal
//     OP_CONFIRM_COLLECT: (empty)                      — execute after timelock

fun recv_external(in_msg: slice) {
    var sig: slice    = in_msg.load_bits(512);
    var msg_hash: int = slice_hash(in_msg);

    var incoming_seqno: int = in_msg.load_uint(32);
    var timestamp:      int = in_msg.load_uint(32);
    var op:             int = in_msg.load_
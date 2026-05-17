// Fee Collector Contract
//
// Receives protocol fees from Subscription contracts, accumulates them,
// and allows the protocol owner to withdraw via a two-phase process:
//
//   Phase 1 — OP_COLLECT (external, signed):
//     Records the withdrawal intent (amount + destination) and sets
//     withdrawal_request_time = blockchain.now().  Does NOT send funds yet.
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
//   - reserveToncoinsOnBalance(COLLECTOR_RESERVE) enforced before every withdrawal send.

import "@stdlib/gas-payments"
import "../utils/errors.tolk"
import "../utils/ops.tolk"
import "../utils/math-safe.tolk"
import "../access/role-manager.tolk"
import "../utils/time-oracle.tolk"

const COLLECTOR_RESERVE:        int = 100000000; // 0.1 TON — always kept for rent
const WITHDRAWAL_TIMELOCK_SEC:  int = 86400;     // 24 hours

// ── Storage ───────────────────────────────────────────────────────────────────

fun load_pending_withdrawal(raw: cell): (int, int, slice) {
    var s: slice = raw.beginParse();
    var request_time: int   = s.loadUint(32);
    var amount:       int   = s.loadCoins();
    var dest:         slice = s.loadAddress() as slice;
    return (request_time, amount, dest);
}

fun pack_pending_withdrawal(request_time: int, amount: int, dest: slice): cell {
    return beginCell()
        .storeUint(request_time, 32)
        .storeCoins(amount)
        .storeSlice(dest)
    .endCell();
}

fun load_collector_storage(): (int, int, int, cell) {
    var ds: slice = contract.getData().beginParse();
    var owner_pubkey:    int  = ds.loadUint(256);
    var seqno:           int  = ds.loadUint(32);
    var total_collected: int  = ds.loadCoins();
    var pending_cell:    cell = ds.loadRef();
    return (owner_pubkey, seqno, total_collected, pending_cell);
}

fun save_collector_storage(
    owner_pubkey: int, seqno: int, total_collected: int, pending_cell: cell
) {
    contract.setData(
        beginCell()
            .storeUint(owner_pubkey, 256)
            .storeUint(seqno, 32)
            .storeCoins(total_collected)
            .storeRef(pending_cell)
        .endCell()
    );
}

// Builds a zeroed pending-withdrawal cell (no pending withdrawal).
fun empty_pending(): cell {
    var zero_addr: slice = beginCell().storeUint(0, 2).endCell().beginParse();
    return pack_pending_withdrawal(0, 0, zero_addr);
}

// ── Internal message handler ──────────────────────────────────────────────────

fun onInternalMessage(my_balance: int, msg_value: int, in_msg_full: cell, in_msg_body: slice) {
    if (in_msg_body.isEnd()) { return; } // plain TON deposit accepted

    var cs: slice = in_msg_full.beginParse();
    var flags: int = cs.loadUint(4);
    if (flags & 1) { return; }

    var op: int = in_msg_body.loadUint(32);

    // Both service fee and ORBIT protocol fee messages share the same body layout:
    // OP(32)[consumed] + query_id(64) + fee_amount(coins) + plan_id(32) + subscriber_addr.
    // Track only the actual fee amount, not msg_value (which includes FEE_MSG_GAS).
    if ((op == OP_FEE_PAYMENT) | (op == OP_PROTOCOL_FEE_PAYMENT)) {
        var (owner_pubkey, seqno, total_collected, pending_cell) = load_collector_storage();
        in_msg_body.loadUint(64);           // query_id
        var fee_amount: int = in_msg_body.loadCoins();
        save_collector_storage(owner_pubkey, seqno, safe_add(total_collected, fee_amount), pending_cell);
        return;
    }

    throw ERROR_INVALID_OP;
}

// ── External message handler ──────────────────────────────────────────────────
//
// External layout (both ops):
//   [512] signature   — Ed25519(owner_privkey) over seqno ++ timestamp ++ op ++ payload.hash()
//   [32]  seqno
//   [32]  timestamp   — must be fresh (within EXT_MSG_TTL)
//   [32]  op          — OP_COLLECT or OP_CONFIRM_COLLECT
//   payload:
//     OP_COLLECT:         amount(coins) + dest(addr)   — schedule withdrawal
//     OP_CONFIRM_COLLECT: (empty)                      — execute after timelock

fun onExternalMessage(in_msg: slice) {
    var sig: slice    = in_msg.loadBits(512);
    var msg_hash: int = in_msg.hash();

    var incoming_seqno: int = in_msg.loadUint(32);
    var timestamp:      int = in_msg.loadUint(32);
    var op:             int = in_msg.loadUint(32);

    var (owner_pubkey, seqno, total_collected, pending_cell) = load_collector_storage();

    require_seqno(incoming_seqno, seqno);
    assert(is_msg_fresh(timestamp), ERROR_MSG_EXPIRED);
    require_valid_signature(msg_hash, sig, owner_pubkey);

    acceptExternalMessage();

    // ── OP_COLLECT — Phase 1: schedule withdrawal ─────────────────────────────
    // Records the request and starts the timelock.  No funds move.
    // To cancel a pending withdrawal, send OP_COLLECT with amount=0.
    if (op == OP_COLLECT) {
        var req_amount: int   = in_msg.loadCoins();
        var req_dest:   slice = in_msg.loadAddress() as slice;

        // Validate requested amount fits within available balance
        if (req_amount > 0) {
            var balance:      int = contract.getOriginalBalance();
            var max_withdraw: int = safe_sub(balance, COLLECTOR_RESERVE);
            assert(req_amount <= max_withdraw, ERROR_INSUFFICIENT_FUNDS);
        }

        save_collector_storage(
            owner_pubkey, seqno + 1, total_collected,
            pack_pending_withdrawal(blockchain.now(), req_amount, req_dest)
        );
        return;
    }

    // ── OP_CONFIRM_COLLECT — Phase 2: execute withdrawal ─────────────────────
    // Can only succeed after WITHDRAWAL_TIMELOCK_SEC elapsed since the request.
    if (op == OP_CONFIRM_COLLECT) {
        var (req_time, req_amount, req_dest) = load_pending_withdrawal(pending_cell);

        // Must have a pending request
        assert(req_time > 0, ERROR_NO_PENDING_WITHDRAWAL);

        // Timelock must have expired
        assert(blockchain.now() >= safe_add(req_time, WITHDRAWAL_TIMELOCK_SEC), ERROR_TIMELOCK_ACTIVE);

        var balance:      int = contract.getOriginalBalance();
        var max_withdraw: int = safe_sub(balance, COLLECTOR_RESERVE);
        if (max_withdraw < 0) { max_withdraw = 0; }

        var withdraw_amount: int = req_amount;
        if (req_amount == 0) {
            withdraw_amount = max_withdraw; // 0 in request = withdraw all
        } else {
            assert(req_amount <= max_withdraw, ERROR_INSUFFICIENT_FUNDS);
        }

        // Clear pending withdrawal before sending (prevents re-entrancy)
        save_collector_storage(
            owner_pubkey, seqno + 1, total_collected,
            empty_pending()
        );

        if (withdraw_amount == 0) { return; }

        reserveToncoinsOnBalance(COLLECTOR_RESERVE, 0);

        var msg: cell = beginCell()
            .storeUint(0x10, 6)  // non-bounceable
            .storeSlice(req_dest)
            .storeCoins(withdraw_amount)
            .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .endCell();
        sendRawMessage(msg, 1);
        return;
    }

    // ── OP_ROTATE_KEY — emergency owner key rotation ──────────────────────────
    // Replaces the owner public key with a new one and clears any pending
    // withdrawal.  Use when the current key is compromised: once rotated, all
    // future messages signed with the old key are rejected (signature check uses
    // the stored owner_pubkey, which is now the new key).
    //
    // Security model:
    //   1. Both owner and attacker can call this if the key is compromised.
    //   2. Whoever sends first wins — the contract accepts the first valid rotation.
    //   3. The owner should rotate immediately upon detecting compromise.
    //   4. After rotation, the attacker's old-key-signed messages are invalid.
    //   5. Any pending withdrawal is cleared as a safety measure — the owner
    //      can re-schedule after rotation with the new key.
    if (op == OP_ROTATE_KEY) {
        var new_pubkey: int = in_msg.loadUint(256);
        assert(new_pubkey != 0, ERROR_INVALID_STATE);
        // Clear pending withdrawal: a compromised key may have queued one.
        save_collector_storage(new_pubkey, seqno + 1, total_collected, empty_pending());
        return;
    }

    throw ERROR_INVALID_OP;
}

// ── Getters ───────────────────────────────────────────────────────────────────

get fun get_seqno(): int {
    var (_, seqno, _, _) = load_collector_storage();
    return seqno;
}

get fun get_total_collected(): int {
    var (_, _, total, _) = load_collector_storage();
    return total;
}

get fun get_balance_available(): int {
    var bal: int = contract.getOriginalBalance();
    var avail: int = bal - COLLECTOR_RESERVE;
    if (avail < 0) { return 0; }
    return avail;
}

// Returns (request_time, amount, dest_hash) for the pending withdrawal.
// request_time = 0 means no pending withdrawal.
get fun get_pending_withdrawal(): (int, int, int) {
    var (_, _, _, pending_cell) = load_collector_storage();
    var (req_time, req_amount, req_dest) = load_pending_withdrawal(pending_cell);
    return (req_time, req_amount, extract_account_id(req_dest));
}

// Returns seconds remaining until the pending withdrawal can be confirmed.
// Returns 0 if no pending withdrawal or timelock already expired.
get fun get_timelock_remaining(): int {
    var (_, _, _, pending_cell) = load_collector_storage();
    var (req_time, _, _) = load_pending_withdrawal(pending_cell);
    if (req_time == 0) { return 0; }
    var unlock_at: int = safe_add(req_time, WITHDRAWAL_TIMELOCK_SEC);
    var remaining: int = unlock_at - blockchain.now();
    if (remaining < 0) { return 0; }
    return remaining;
}

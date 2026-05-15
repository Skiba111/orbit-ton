// FunC compatibility shim for ORBIT.
//
// If you have an existing FunC-based subscription contract and want to
// migrate to ORBIT without rewriting everything, include this file.
// It re-exports ORBIT's core functions under the old FunC naming conventions
// and provides a message-format adapter.
//
// Usage:
//   1. Add `import "orbit/migration/func-compat.tolk"` to your FunC project
//      (after migrating it to Tolk, or via the tolk-func bridge).
//   2. Replace your recv_internal handler body with orbit_recv_internal().
//   3. Deploy the upgraded contract.
//
// Message compatibility:
//   Old FunC format: op(32) query_id(64) ...
//   ORBIT format:    op(32) query_id(64) ...
//   Both formats are identical — no translation needed for standard ops.
//   Custom op codes are mapped via the COMPAT_OP_* constants below.

import "../utils/ops.tolk"
import "../utils/errors.tolk"
import "../core/storage-layout.tolk"

// ── Legacy op-code aliases ────────────────────────────────────────────────────
// Map whatever your old contract used to ORBIT's constants.
// EDIT THESE to match your existing contract's op codes.

const COMPAT_OP_CHARGE:     int = 0x706c7567; // example legacy "plug" op
const COMPAT_OP_CANCEL:     int = 0x63616e63; // example legacy "canc" op

// ── Op-code translation ───────────────────────────────────────────────────────

// Returns the canonical ORBIT op for an incoming legacy op code,
// or -1 if the code is not recognised as a legacy op.
@inline
fun translate_op(legacy_op: int): int {
    if (legacy_op == COMPAT_OP_CHARGE) { return OP_CHARGE_EXT; }
    if (legacy_op == COMPAT_OP_CANCEL) { return OP_CANCEL; }
    return -1;
}

// Wraps an incoming message body: if the op is legacy, rewrites it to the
// ORBIT canonical op before dispatching.  Returns the (potentially rewritten)
// body slice.
fun normalize_op(in_msg_body: slice): (int, slice) {
    var op: int = in_msg_body.loadUint(32);
    var canonical: int = translate_op(op);
    if (canonical != -1) {
        return (canonical, in_msg_body);
    }
    return (op, in_msg_body);
}

// ── State migration helper ────────────────────────────────────────────────────
//
// If your old contract stored subscription data in a different layout,
// call this once during the first interaction to migrate the state.
// Returns a packed ORBIT storage cell from legacy fields.
//
// New fields in v3 storage (all zeroed / off by default):
//   keeper_mode     = 0 (standard signed relayer mode)
//   max_periods     = 0 (unlimited)
//   periods_charged = 0 (fresh start)
//   factory_addr    = must be provided (address of the ORBIT factory contract)

fun migrate_from_legacy(
    subscriber:         slice,
    service:            slice,
    factory:            slice,   // address of the ORBIT Factory contract
    amount:             int,
    period:             int,
    next_charge_time:   int,
    fee_collector:      slice,
    fee_bps:            int,
    relayer_pubkey:     int      // provide the relayer's Ed25519 pubkey; must not be 0
): cell {
    // Assumes plan_id = 0 (default), no trial, payment type = TON.
    var zero_addr: slice = beginCell().storeUint(0, 2).endCell().beginParse();
    return pack_subscription(
        0,                   // seqno starts at 0
        STATUS_ACTIVE,
        1,                   // PAYMENT_TON
        0,                   // charging_in_progress = false
        0,                   // paused_global = false
        0,                   // keeper_mode = off
        0,                   // retry_count
        period,
        next_charge_time,
        0,                   // grace_end_time
        0,                   // plan_id (legacy = 0)
        0,                   // max_periods = unlimited
        0,                   // periods_charged = 0
        amount,
        amount,              // deposit = one period pre-funded
        STORAGE_RESERVE,
        fee_bps,
        0,                   // trial_period = 0
        service,
        subscriber,
        factory,             // factory_addr — required for OP_APPLY_PLAN auth
        fee_collector,
        zero_addr,           // jetton_wallet = null
        relayer_pubkey,
        zero_addr            // protocol_fee_collector — use addr_none; caller should update via Factory
    );
}

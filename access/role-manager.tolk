// Role-based access control for ORBIT contracts.
//
// Roles:
//   OWNER     — the service operator; can add/remove plans, pause, withdraw
//   SUBSCRIBER— the end-user; can top-up deposit and cancel
//   RELAYER   — anyone holding the relayer key; may only trigger charges
//
// Address comparison: TON addr_std slices may differ in their anycast / workchain
// prefix bytes while referring to the same account.  We extract the 256-bit
// account_id (the hash part) and compare that directly — format-independent.

import "../utils/errors.tolk"

// Extracts the 256-bit account_id from an addr_std slice.
// Returns 0 for addr_none / addr_extern (no valid account_id).
@inline
fun extract_account_id(addr: slice): int {
    var tag: int = addr.load_uint(2);
    if (tag != 2) { return 0; } // addr_none(0b00) or addr_extern(0b01) — not addr_std
    var has_anycast: int = addr.load_uint(1);
    if (has_anycast) {
        var depth: int = addr.load_uint(5);
        addr~skip_bits(depth); // skip anycast rewrite prefix
    }
    addr~skip_bits(8); // workchain_id
    return addr.load_uint(256);
}

// Returns true when addr is addr_none (first two bits = 0b00).
// Used to distinguish "not set yet" from a real address (e.g. jetton_wallet before auto-learn).
@inline
fun is_addr_none(addr: slice): int {
    return addr.preload_uint(2) == 0;
}

// Compares two address slices by their 256-bit account_id only.
// Correctly handles address slices in different serialisation formats
// (with/without anycast, different workchain byte representations).
@inline
fun addr_equal(a: slice, b: slice): int {
    return extract_account_id(a) == extract_account_id(b);
}

// ── Guards ────────────────────────────────────────────────────────────────────

@inline
fun require_owner(sender: slice, owner: slice) {
    throw_unless(ERROR_UNAUTHORIZE
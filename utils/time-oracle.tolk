// Block-timestamp utilities.
// TON's blockchain.now() is the block unix timestamp — no external oracle needed.

// How many seconds a relayer may send a charge message BEFORE the exact
// next_billing_time.  Needed because message propagation takes time.
const CHARGE_TOLERANCE_SEC:  int = 120;   // 2 minutes early is fine

// Maximum age of a signed external message before it is rejected.
// Prevents a relayer from replaying old messages if the contract was paused.
const EXT_MSG_TTL:           int = 60;    // 60 seconds

// After a failed charge the contract enters a grace period before giving up.
const DEFAULT_GRACE_SEC:     int = 259200; // 3 days — industry standard for subscription grace

// ── Helpers ──────────────────────────────────────────────────────────────────

// Returns true when billing is due (with tolerance window).
@inline
fun is_billing_due(next_billing_time: int): bool {
    return blockchain.now() >= (next_billing_time - CHARGE_TOLERANCE_SEC);
}

// Returns true while still inside the grace window.
@inline
fun is_in_grace(grace_end_time: int): bool {
    return (grace_end_time > 0) && (blockchain.now() < grace_end_time);
}

// Returns true when an external message timestamp is still fresh.
@inline
fun is_msg_fresh(msg_timestamp: int): bool {
    var age: int = blockchain.now() - msg_timestamp;
    return (age >= 0) && (age <= EXT_MSG_TTL);
}

// Period advancement is handled by advance_billing() in core/period-math.tolk.

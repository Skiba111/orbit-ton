// Grace period and retry scheduler.
//
// When a charge fails (insufficient deposit), the subscription transitions
// to STATUS_GRACE for DEFAULT_GRACE_SEC.  The relayer keeps calling charge;
// if the subscriber tops up in time the charge succeeds normally.
// After MAX_RETRY failures the subscription is cancelled automatically.

import "../utils/errors.tolk"
import "../utils/time-oracle.tolk"
import "../utils/math-safe.tolk"
import "../core/subscription-state.tolk"

// ── Grace-period helpers ──────────────────────────────────────────────────────

// Computes the end of the grace window when a charge first fails.
@inline
fun compute_grace_end(grace_duration: int): int {
    return safe_add(blockchain.now(), grace_duration);
}

// Returns true when the grace period has expired without a successful charge.
@inline
fun grace_expired(grace_end_time: int): bool {
    return (grace_end_time > 0) && (blockchain.now() >= grace_end_time);
}

// ── Retry state transitions ───────────────────────────────────────────────────

// Called when a charge attempt fails.  Returns updated (status, retry_count,
// grace_end_time) — the contract saves these and tries again on the next
// relayer call within the grace window.
fun on_charge_failed(
    retry_count:   int,
    grace_end_time: int,
    grace_duration: int
): (int, int, int) {
    var new_retry: int = retry_count + 1;

    if (new_retry >= MAX_RETRY) {
        // Too many failures — cancel the subscription.
        return (STATUS_CANCELLED, new_retry, 0);
    }

    // First failure or re-entry: extend / set grace window.
    var new_grace: int = grace_end_time;
    if (grace_end_time == 0) {
        new_grace = compute_grace_end(grace_duration);
    }
    return (STATUS_GRACE, new_retry, new_grace);
}

// Called when a charge eventually succeeds after one or more failures.
// Resets retry counter and clears grace window.
@inline
fun on_charge_succeeded_after_grace(): (int, int, int) {
    return (STATUS_ACTIVE, 0, 0);
}

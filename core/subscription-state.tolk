// Subscription state-machine.
//
//  TRIAL ──► ACTIVE ──► GRACE ──► CANCELLED (non-payment)
//              │                       ▲
//              └───────────────────────┘  (user cancel)
//              │
//              ▼
//           PAUSED ──► ACTIVE (resume)
//
// Transitions are enforced by require_state / assert_can_charge.

import "../utils/errors.tolk"

// ── Status codes (4 bits) ────────────────────────────────────────────────────
const STATUS_TRIAL:      int = 1;
const STATUS_ACTIVE:     int = 2;
const STATUS_PAUSED:     int = 3;
const STATUS_GRACE:      int = 4;  // failed charge, waiting for retry
const STATUS_CANCELLED:  int = 5;

// ── Payment type (2 bits) ────────────────────────────────────────────────────
const PAYMENT_TON:       int = 1;
const PAYMENT_JETTON:    int = 2;

// ── Transition guards ────────────────────────────────────────────────────────

@inline
fun require_active_or_trial(status: int) {
    assert((status == STATUS_ACTIVE) || (status == STATUS_TRIAL), ERROR_INVALID_STATE);
}

@inline
fun require_chargeable(status: int) {
    assert((status == STATUS_ACTIVE) || (status == STATUS_TRIAL) || (status == STATUS_GRACE), ERROR_INVALID_STATE);
}

@inline
fun require_not_cancelled(status: int) {
    assert(status != STATUS_CANCELLED, ERROR_INVALID_STATE);
}

@inline
fun require_paused(status: int) {
    assert(status == STATUS_PAUSED, ERROR_INVALID_STATE);
}

// Returns the status to set when a charge attempt fails.
// If retries remain → GRACE; if exhausted → CANCELLED.
@inline
fun next_status_on_failure(retry_count: int, max_retries: int): int {
    if (retry_count < max_retries) {
        return STATUS_GRACE;
    }
    return STATUS_CANCELLED;
}

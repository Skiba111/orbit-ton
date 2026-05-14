// Trial period logic.
//
// When a plan has trial_period > 0 and the subscriber has not used a trial
// before, the first billing cycle is free: billing amount = 0, the
// status is set to STATUS_TRIAL, and next_billing_time is set to
// now() + trial_period (not now() + period).
//
// After the trial ends, the first real charge fires and the subscription
// transitions to STATUS_ACTIVE.
//
// Trial tracking: a per-subscriber flag is stored in the Factory's
// "used_trials" dictionary to prevent re-use across re-subscriptions.
//
// Known limitation: a subscriber can bypass this by creating a new wallet
// (different address → different hash → fresh trial flag).  There is no
// fully-trustless on-chain solution to Sybil resistance.  Mitigations:
//   • Require a minimum wallet seqno (proves the wallet is not brand-new).
//   • Apply off-chain KYC / account age checks before granting trial plans.
//   • Set trial_period = 0 for high-value plans and manage trials off-chain.

import "../utils/errors.tolk"
import "../utils/time-oracle.tolk"
import "../core/subscription-state.tolk"

// Returns true when this subscription should start as a trial.
@inline
fun should_start_trial(trial_period: int, trial_used: int): int {
    return (trial_period > 0) & (trial_used == 0);
}

// Computes the initial next_billing_time depending on trial eligibility.
fun initial_billing_time(trial_period: int, period: int, trial_used: int): int {
    if (should_start_trial(trial_period, trial_used)) {
        // Trial: first billing fires after trial_period seconds
        return now() + trial_period;
    }
    // No trial: first billing fires immediately after one period
    return now() + period;
}

// Returns the initial status.
@inline
fun initial_status(trial_period: int, trial_used: int): int {
    if (should_start_trial(trial_period, trial_used)) {
        return STATUS_TRIAL;
    }
    return STATUS_ACTIVE;
}

// ── Factory trial-tracking dict helpers ──────────────────────────────────────

// Key: address hash (256 bits), value: 1 bit "trial used"
fun trial_is_used(used_trials: cell, subscriber_hash: int): int {
    var (_, found) = used_trials.udict_get?(256, subscriber_hash);
    return found;
}

fun mark_trial_used(used_trials: cell, subscriber_hash: int): cell {
    return used_trials.udict_set(256, subscriber_hash, begin_cell().store_uint(1, 1).end_cell().begin_parse());
}

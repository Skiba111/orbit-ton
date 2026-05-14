// Plan registry — stored in the Factory contract.
//
// A plan is a template; when a user subscribes, the plan fields are
// snapshot-copied into the Subscription contract so future plan changes
// don't affect existing subscribers (bait-and-switch protection).
//
// Plans are stored as a 32-bit keyed dictionary inside the Factory's cell.
// No hard plan limit — plan_id is uint32 (up to ~4 billion plans).
//
// name_hash: keccak256 / sha256 of the human-readable plan name, stored
// on-chain for indexing.  Off-chain tooling maps hash → display string.

import "../utils/errors.tolk"
import "../utils/math-safe.tolk"

// ── Plan serialisation ────────────────────────────────────────────────────────

fun pack_plan(
    price:          int,
    period:         int,
    trial_period:   int,
    active:         int,
    name_hash:      int
): cell {
    return begin_cell()
        .store_coins(price)
        .store_uint(period,       32)
        .store_uint(trial_period, 32)
        .store_uint(active,        1)
        .store_uint(name_hash,   256)
    .end_cell();
}

fun unpack_plan(raw: cell): (int, int, int, int, int) {
    var s: slice = raw.begin_parse();
    var price:        int = s.load_coins();
    var period:       int = s.load_uint(32);
    var trial_period: int = s.load_uint(32);
    var active:       int = s.load_uint(1);
    var name_hash:    int = s.load_uint(256);
    return (price, period, trial_period, active, name_hash);
}

// ── Registry helpers ──────────────────────────────────────────────────────────

// Returns the plan cell from a plans dict; throws if not found.
fun get_plan(plans: cell, plan_id: int): cell {
    var (val, found) = plans.udict_get?(32, plan_id);
    throw_unless(ERROR_NOT_FOUND, found);
    return val.preload_ref();
}

// Validates plan parameters before storing.
// trial_period = 0 means no trial, which is valid; non-zero must pass validate_period.
fun validate_plan(price: int, period: int, trial_period: int) {
    validate_amount(price);
    validate_period(period);
    if (trial_period > 0) {
        validate_period(trial_period);
    }
}

// Adds or replaces a plan in the dict.
fun set_plan(plans: cell, plan_id: int, price: int, period: int, trial_period: int, name_hash: int): cell {
    validate_plan(price, period, trial_period);
    var plan_cell: cell = pack_plan(price, period, trial_period, 1, name_hash);
    return plans.udict_set_ref(32, plan_id, plan_cell);
}

// Deactivates a plan (existing subscribers are not affected).
fun deactivate_plan(plans: cell, plan_id: int): cell {
    var (price, period, trial_period, _, name_hash) = unpack_plan(get_plan(plans, plan_id));
    var plan_cell: cell = pack_plan(price, period, trial_period, 0, name_hash);
    return plans.udict_set_ref(32, plan_id, plan_cell);
}

// Reads a plan and asserts it is active, then returns its fields.
fun require_active_plan(plans: cell, plan_id: int): (int, int, int) {
    var (price, period, trial_period, active, _) = unpack_plan(get_plan(plans, plan_id));
    throw_unless(ERROR_PLAN_INACTIVE, active == 1);
    return (price, period, trial_period);
}

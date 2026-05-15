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

import "@stdlib/tvm-dicts"
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
    return beginCell()
        .storeCoins(price)
        .storeUint(period,       32)
        .storeUint(trial_period, 32)
        .storeUint(active,        1)
        .storeUint(name_hash,   256)
    .endCell();
}

fun unpack_plan(raw: cell): (int, int, int, int, int) {
    var s: slice = raw.beginParse();
    var price:        int = s.loadCoins();
    var period:       int = s.loadUint(32);
    var trial_period: int = s.loadUint(32);
    var active:       int = s.loadUint(1);
    var name_hash:    int = s.loadUint(256);
    return (price, period, trial_period, active, name_hash);
}

// ── Registry helpers ──────────────────────────────────────────────────────────

// Returns the plan cell from a plans dict; throws if not found.
fun get_plan(plans: dict, plan_id: int): cell {
    var (entry, found) = plans.uDictGet(32, plan_id);
    assert(found, ERROR_NOT_FOUND);
    return entry!.preloadRef();
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
fun set_plan(plans: dict, plan_id: int, price: int, period: int, trial_period: int, name_hash: int): dict {
    validate_plan(price, period, trial_period);
    var plan_cell: cell = pack_plan(price, period, trial_period, 1, name_hash);
    plans.uDictSetRef(32, plan_id, plan_cell);
    return plans;
}

// Deactivates a plan (existing subscribers are not affected).
fun deactivate_plan(plans: dict, plan_id: int): dict {
    var (price, period, trial_period, _, name_hash) = unpack_plan(get_plan(plans, plan_id));
    var plan_cell: cell = pack_plan(price, period, trial_period, 0, name_hash);
    plans.uDictSetRef(32, plan_id, plan_cell);
    return plans;
}

// Reads a plan and asserts it is active, then returns its fields.
fun require_active_plan(plans: dict, plan_id: int): (int, int, int) {
    var (price, period, trial_period, active, _) = unpack_plan(get_plan(plans, plan_id));
    assert(active == 1, ERROR_PLAN_INACTIVE);
    return (price, period, trial_period);
}

// Emergency pause module.
//
// A single flag (paused_global) blocks all state-changing operations.
// Only the service owner can toggle it via OP_EMERGENCY_PAUSE.
// Read-only getters continue to work while paused.
//
// Design choice: pause is stored in contract state rather than in a
// registry contract, so each subscription can be inspected individually
// and no cross-contract calls are needed to resume.

import "../utils/errors.tolk"

// Throws ERROR_PAUSED when the global pause flag is set.
@inline
fun require_not_paused(paused_global: int) {
    throw_if(ERROR_PAUSED, paused_global == 1);
}

// Returns the toggled pause state (0 → 1, 1 → 0).
@inline
fun toggle_pause(paused_global: int): int {
    return 1 - paused_global;
}

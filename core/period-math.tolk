import "../utils/math-safe.tolk"
import "../utils/time-oracle.tolk"

// ── Period helpers ───────────────────────────────────────────────────────────

// Advance billing time by one period without drift.
// If the contract missed several cycles (e.g. long pause) we still only
// advance by one period at a time — the relayer calls charge repeatedly.
@inline
fun advance_billing(next_billing_time: int, period: int): int {
    return safe_add(next_billing_time, period);
}

// How many full periods fit inside a deposit at a given price.
@inline
fun periods_covered(deposit: int, period_price: int): int {
    if (period_price == 0) { return MAX_UINT32; }
    return deposit / period_price;
}

// Minimum deposit required to cover n periods plus a storage reserve.
@inline
fun min_deposit(period_price: int, periods: int, storage_reserve: int): int {
    return safe_add(safe_mul(period_price, periods), storage_reserve);
}

// Returns true when the deposit can cover one billing cycle plus gas budget.
// Requires: amount + storage_reserve + CHARGE_GAS_BUDGET ≤ deposit.
// CHARGE_GAS_BUDGET covers TVM execution and the outgoing payment messages
import "errors.tolk"

// ── Bounds ──────────────────────────────────────────────────────────────────
const MIN_PERIOD:       int = 3600;       // 1 hour
const MAX_PERIOD:       int = 315360000;  // 10 years
const MAX_FEE_BPS:      int = 1000;       // 10% absolute ceiling
const MAX_RETRY:        int = 5;
const MAX_UINT32:       int = 0xFFFFFFFF;

// TVM integers are 257-bit signed, but we stay well within uint128 for coins.
const MAX_COINS:        int = 1329227995784915872903807060280344575; // 2^120 - 1

// Gas budget reserved for the charge transaction itself (TVM execution + messages).
const CHARGE_GAS_BUDGET: int = 30000000; // 0.03 TON

// Reward paid to a keeper per successful charge trigger (shared by charge-engine and factory).
const KEEPER_REWARD: int = 10000000; // 0.01 TON

// ── Safe arithmetic ─────────────────────────────────────────────────────────

@inline
fun safe_add(a: int, b: int): int {
    var result: int = a + b;
    assert(!(result < a), ERROR_OVERFLOW);
    return result;
}

@inline
fun safe_sub(a: int, b: int): int {
    assert(!(b > a), ERROR_OVERFLOW);
    return a - b;
}

@inline
fun safe_mul(a: int, b: int): int {
    if (b == 0) { return 0; }
    var result: int = a * b;
    assert(!(result / b != a), ERROR_OVERFLOW);
    return result;
}

// Basis-points fee: returns floor(amount * bps / 10000).
// Safe because bps ≤ MAX_FEE_BPS (1000) and amount fits in coins range.
@inline
fun bps_of(amount: int, bps: int): int {
    return (amount * bps) / 10000;
}

// ── Validation helpers ───────────────────────────────────────────────────────

@inline
fun validate_period(period: int) {
    assert((period >= MIN_PERIOD) & (period <= MAX_PERIOD), ERROR_INVALID_PERIOD);
}

@inline
fun validate_amount(amount: int) {
    assert((amount > 0) & (amount <= MAX_COINS), ERROR_INVALID_AMOUNT);
}

@inline
fun validate_fee_bps(bps: int) {
    assert((bps >= 0) & (bps <= MAX_FEE_BPS), ERROR_INVALID_AMOUNT);
}

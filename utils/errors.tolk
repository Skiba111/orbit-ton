// ORBIT error codes — all exits go through these constants so auditors
// have a single reference point for every revert path.

// Access control
const ERROR_UNAUTHORIZED:        int = 401;
const ERROR_WRONG_SENDER:        int = 403;

// Subscription state
const ERROR_NOT_FOUND:           int = 404;
const ERROR_INVALID_STATE:       int = 409;
const ERROR_ALREADY_EXISTS:      int = 412;
const ERROR_ALREADY_CHARGING:    int = 423;
const ERROR_TOO_EARLY:           int = 425;
const ERROR_PLAN_INACTIVE:       int = 410;
const ERROR_TRIAL_USED:          int = 426;

// Financial
const ERROR_INSUFFICIENT_FUNDS:  int = 402;
const ERROR_OVERFLOW:            int = 500;
const ERROR_STORAGE_RESERVE:     int = 507;

// Input validation
const ERROR_INVALID_OP:          int = 0xffff;
const ERROR_INVALID_PERIOD:      int = 422;
const ERROR_INVALID_AMOUNT:      int = 416;
const ERROR_INVALID_PLAN:        int = 415;
const ERROR_INVALID_SEQNO:       int = 424;
const ERROR_REPLAY:              int = 427;
const ERROR_SIGNATURE:           int = 428;
const ERROR_MSG_EXPIRED:         int = 429;

// System
const ERROR_PAUSED:              int = 503;
const ERROR_JETTON_PENDING:      int = 504;

// Timelock
const ERROR_TIMELOCK_ACTIVE:       int = 430; // withdrawal timelock not elapsed yet
const ERROR_NO_PENDING_WITHDRAWAL: int = 406; // no scheduled withdrawal to confirm

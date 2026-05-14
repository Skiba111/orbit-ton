// ORBIT operation codes for internal and external messages.
// All 32-bit, prefixed with 0x4F52 ("OR" for ORBIT) to avoid collisions.

// ── Factory ops (internal, user → factory) ─────────────────────────────────
const OP_SUBSCRIBE:              int = 0x4F520001; // deploy subscription contract
const OP_ADD_PLAN:               int = 0x4F520002; // add new plan
const OP_DEACTIVATE_PLAN:        int = 0x4F520003; // deactivate plan
const OP_FACTORY_PAUSE:          int = 0x4F520004; // pause all new subscriptions
const OP_FACTORY_RESUME:         int = 0x4F520005; // resume
const OP_FACTORY_WITHDRAW:       int = 0x4F520006; // owner withdraw gas reserve

// ── Subscription ops (internal) ────────────────────────────────────────────
const OP_CANCEL:                 int = 0x4F520010; // subscriber cancels
const OP_TOP_UP:                 int = 0x4F520011; // subscriber tops up deposit
const OP_PAUSE_SUB:              int = 0x4F520012; // service pauses one subscription
const OP_RESUME_SUB:             int = 0x4F520013; // service resumes one subscription
const OP_EMERGENCY_PAUSE:        int = 0x4F520014; // owner kills everything

// ── Billing ops (internal, subscription → service/fee-collector) ───────────
const OP_CHARGE_INTERNAL:        int = 0x4F520020; // subscription sends payment to service
const OP_FEE_PAYMENT:            int = 0x4F520021; // subscription sends fee to collector
const OP_REFUND:                 int = 0x4F520022; // return deposit to subscriber

// ── External ops (relayer → subscription) ──────────────────────────────────
const OP_CHARGE_EXT:             int = 0x4F520030; // relayer triggers billing cycle

// ── Jetton ops (standard TEP-74) ───────────────────────────────────────────
const OP_JETTON_TRANSFER:              int = 0xf8a7ea5;
const OP_JETTON_TRANSFER_NOTIFICATION: int = 0x7362d09c;
const OP_JETTON_EXCESSES:              int = 0xd53276db;

// ── Subscription admin ops (internal, service → subscription) ─────────────
const OP_ROTATE_RELAYER:         int = 0x4F520015; // service rotates relayer key
const OP_APPLY_PLAN:             int = 0x4F520016; // factory applies plan change to s
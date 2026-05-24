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
const OP_APPLY_PLAN:             int = 0x4F520016; // factory applies plan change to subscription

// ── Factory plan-change ops (internal, subscriber → factory) ──────────────
const OP_CHANGE_PLAN:            int = 0x4F520007; // subscriber requests plan change

// ── Analytics ops (internal, subscription → factory) ──────────────────────
const OP_CHARGE_NOTIFICATION:    int = 0x4F520008; // subscription reports successful charge

// ── Fee collector ops ──────────────────────────────────────────────────────
const OP_COLLECT:                int = 0x4F520040; // phase 1: request withdrawal (starts timelock)
const OP_CONFIRM_COLLECT:        int = 0x4F520041; // phase 2: confirm after timelock expires
const OP_ROTATE_KEY:             int = 0x4F520042; // emergency: rotate owner key + clear pending

// ── Keeper / factory ops ───────────────────────────────────────────────────
const OP_FUND_KEEPER_POOL:       int = 0x4F520009; // service funds keeper reward pool

// ── Subscription admin ops (service → subscription) ────────────────────────
const OP_SET_MAX_PERIODS:        int = 0x4F520017; // service sets fixed-term cap on existing sub

// ── Factory admin ops ──────────────────────────────────────────────────────
// @deprecated OP_UPDATE_FEE_BPS (0x4F52000A) — REMOVED in v0.1.4
// fee_bps is immutable after Factory deployment.  Snapshot protection for both
// subscribers (no bait-and-switch) and ORBIT (no fee zeroing via Registry).
// This constant is intentionally absent.  Any code referencing it will fail to
// compile — surfacing the design change at build time instead of runtime.
const OP_UPDATE_PROTOCOL_COLLECTOR:   int = 0x4F52000B; // ORBIT owner rotates protocol_fee_collector

// ── Protocol fee billing op ────────────────────────────────────────────────
const OP_PROTOCOL_FEE_PAYMENT:        int = 0x4F520023; // subscription sends ORBIT protocol fee

// ── Registry ops (internal, developer → registry) ─────────────────────────
const OP_REGISTRY_REGISTER:           int = 0x4F520060; // deploy a Factory for the sender
const OP_REGISTRY_UPDATE_FEE:         int = 0x4F520061; // owner: update platform_fee_bps
const OP_REGISTRY_UPDATE_COLLECTOR:   int = 0x4F520062; // owner: update fee_collector address
const OP_REGISTRY_UPDATE_RELAYER:     int = 0x4F520063; // owner: update relayer_pubkey
const OP_REGISTRY_PAUSE:              int = 0x4F520064; // owner: pause new registrations
const OP_REGISTRY_RESUME:             int = 0x4F520065; // owner: resume registrations
const OP_REGISTRY_WITHDRAW:           int = 0x4F520066; // owner: withdraw excess TON
const OP_REGISTRY_UPDATE_PROTOCOL_COLLECTOR: int = 0x4F520067; // owner: rotate protocol_fee_collector
const OP_REGISTRY_DEREGISTER:               int = 0x4F520068; // owner: emergency removal of a service entry

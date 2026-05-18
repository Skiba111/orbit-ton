// ORBIT Protocol fee configuration.
//
// PROTOCOL_FEE_BPS (1.5%) is a compile-time constant — baked into the Subscription bytecode.
// A service cannot change it without recompiling from source (which produces different
// bytecode and is no longer "official ORBIT").
//
// ── How protocol_fee_collector is actually set ────────────────────────────────
//
// The actual routing of the 1.5% fee is NOT determined by PROTOCOL_FEE_COLLECTOR_HASH
// at runtime. The real flow is:
//   1. Operator passes `protocolFeeCollector` address when deploying Factory.
//   2. Factory stores it in its state (ref3).
//   3. Factory passes it to every new Subscription at deploy time.
//   4. Each Subscription stores it and sends 1.5% there on every charge.
//
// PROTOCOL_FEE_COLLECTOR_HASH and get_protocol_fee_collector() below are
// REFERENCE CONSTANTS — they are not called by any contract at runtime.
// They serve as documentation and can be used by off-chain tooling.
//
// For mainnet: make sure to pass the correct FeeCollector address when running
//   ts-node scripts/deploy-standalone.ts
// (prompt: "Protocol fee collector address")
//
// To compute the hash for any address:
//   node -e "const {Address}=require('@ton/core'); console.log('0x'+Buffer.from(Address.parse('EQD...').hash).toString('hex'))"

// 1.5% of every billing cycle — non-negotiable, lives in bytecode.
const PROTOCOL_FEE_BPS: int = 150;

// 256-bit account_id of the ORBIT FeeCollector contract (mainnet).
// NOTE: this constant is reference-only — actual routing uses the address passed at deploy time
// (see the comment block above). Changing this value does NOT affect deployed contracts.
// To compute a hash for any address:
//   node -e "const {Address}=require('@ton/core'); console.log('0x'+Address.parse('EQD...').hash.toString('hex'))"
const PROTOCOL_FEE_COLLECTOR_HASH: int = 0xd79931e826f8da865753dffb69786719d23ba200311f85306229c42e14f9e3cf;

// Reference helper — NOT called at runtime. See note above.
// workchain = 0, addr_std format (3-bit tag 0b100 + 8-bit workchain + 256-bit hash).
@inline
fun get_protocol_fee_collector(): slice {
    return beginCell()
        .storeUint(4, 3)                            // addr_std tag: 0b100
        .storeInt(0, 8)                             // workchain 0
        .storeUint(PROTOCOL_FEE_COLLECTOR_HASH, 256)
    .endCell().beginParse();
}

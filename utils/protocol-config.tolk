// ORBIT Protocol fee configuration.
//
// PROTOCOL_FEE_BPS (0.2%) is a compile-time constant — baked into the Subscription bytecode.
// A service cannot change it without recompiling from source (which produces different
// bytecode and is no longer "official ORBIT").
//
// ── How protocol_fee_collector is actually set ────────────────────────────────
//
// The actual routing of the 0.2% fee is NOT determined by PROTOCOL_FEE_COLLECTOR_HASH
// at runtime. The real flow is:
//   1. Operator passes `protocolFeeCollector` address when deploying Factory.
//   2. Factory stores it in its state (ref3).
//   3. Factory passes it to every new Subscription at deploy time.
//   4. Each Subscription stores it and sends 0.2% there on every charge.
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

// 0.2% of every billing cycle — non-negotiable, lives in bytecode.
const PROTOCOL_FEE_BPS: int = 20;

// 256-bit account_id of the ORBIT FeeCollector contract (testnet).
// Testnet FeeCollector: EQDDU30Vfvjf4wVgyw5Mzh3aMmcvP7Y0sFb2zQ-2tTNbadze
// Update to mainnet FeeCollector hash before mainnet deployment.
const PROTOCOL_FEE_COLLECTOR_HASH: int = 0xc3537d157ef8dfe30560cb0e4cce1dda32672f3fb634b056f6cd0fb6b5335b69;

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

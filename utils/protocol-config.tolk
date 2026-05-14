// ORBIT Protocol fee configuration — hardcoded in every Subscription bytecode.
//
// IMPORTANT: These constants are baked into the compiled Subscription binary.
// A service cannot change them without recompiling from source, which produces
// different bytecode and is no longer "official ORBIT."
//
// PROTOCOL_FEE_COLLECTOR_HASH: the 256-bit account_id of your TON wallet.
// Get it with:
//   node -e "const {Address}=require('@ton/core'); console.log('0x'+Address.parse('YOUR_ADDR').hash.toString('hex'))"
//
// Replace the placeholder below with your real address BEFORE building for mainnet.
// For testnet you may use your testnet wallet hash.
//
// Rotation: if you need to redirect fees to a new wallet, you must:
//   1. Update PROTOCOL_FEE_COLLECTOR_HASH in this file
//   2. Recompile the Subscription contract
//   3. Deploy a new Factory with the new sub_code
//   New subscriptions will send to the new address; existing ones to the old
//   address (which you still control). No funds are ever lost.

// 0.2 % of every billing cycle — non-negotiable, lives in bytecode.
const PROTOCOL_FEE_BPS: int = 20;

// TODO: replace with your mainnet wallet's 256-bit account_id before production.
// Current value is a placeholder — contracts compiled with 0 will send the
// protocol fee to the zero address and it will be permanently lost.
const PROTOCOL_FEE_COLLECTOR_HASH: int = 0;

// Builds the protocol fee collector address from the hardcoded hash constant.
// workchain = 0, addr_std format (3-bit tag 0b100 + 8-bit workchain + 256-bit hash).
@inline
fun get_protocol_fee_collector(): slice {
    return begin_cell()
        .store_uint(4, 3)                           // addr_std tag: 0b100
        .store_int(0, 8)                            // workchain 0
        .store_uint(PROTOCOL_FEE_COLLECTOR_HASH, 256)
    .end_cell().begin_parse();
}

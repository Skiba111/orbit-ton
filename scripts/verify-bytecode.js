/**
 * ORBIT official bytecode verifier.
 *
 * Usage:
 *   node scripts/verify-bytecode.js
 *     — prints the code hash of the locally compiled Subscription contract.
 *       Run this after setting PROTOCOL_FEE_COLLECTOR_HASH and rebuilding
 *       to get the hash you should publish as the "official ORBIT hash".
 *
 *   node scripts/verify-bytecode.js <CONTRACT_ADDRESS>
 *     — fetches the deployed contract's code from mainnet and compares it
 *       against the locally compiled version.
 *
 * Example:
 *   node scripts/verify-bytecode.js EQD...subscriptionAddress...
 */

const path = require("path");

async function getLocalHash() {
    const { compileTolk } = require(path.join(__dirname, "../tests/helpers/compileTolk"));
    const code = await compileTolk("subscription");
    return code.hash().toString("hex");
}

async function getOnchainHash(address) {
    const { TonClient, Address } = require("@ton/core");
    const network = process.env.NETWORK ?? "mainnet";
    const endpoint = network === "mainnet"
        ? "https://toncenter.com/api/v2/jsonRPC"
        : "https://testnet.toncenter.com/api/v2/jsonRPC";

    const client  = new TonClient({ endpoint });
    const state   = await client.getContractState(Address.parse(address));

    if (state.state !== "active") {
        throw new Error(`Contract ${address} is not active (state: ${state.state})`);
    }
    if (!state.code) {
        throw new Error(`Contract ${address} has no code cell`);
    }

    const { Cell } = require("@ton/core");
    return Cell.fromBoc(state.code)[0].hash().toString("hex");
}

async function main() {
    const address = process.argv[2];

    console.log("Building local Subscription contract…");
    const localHash = await getLocalHash();
    console.log("\n  Local hash  :", localHash);

    if (!address) {
        console.log("\nThis is the hash to publish as the official ORBIT bytecode hash.");
        console.log("Save it and add it to your README / website / Telegram channel.");
        return;
    }

    console.log("\nFetching on-chain code for", address, "…");
    let onchainHash;
    try {
        onchainHash = await getOnchainHash(address);
    } catch (err) {
        console.error("\n  ERROR:", err.message);
        process.exit(1);
    }
    console.log("  On-chain hash:", onchainHash);

    if (localHash === onchainHash) {
        console.log("\n  ✅  MATCH — this is official ORBIT bytecode.");
        console.log("      Protocol fee (0.2%) is active and routes to the published collector.");
    } else {
        console.log("\n  ❌  MISMATCH — this contract was compiled from modified source.");
        console.log("      It may have a different fee rate or a different fee collector.");
        process.exit(1);
    }
}

main().catch((err) => { console.error(err); process.exit(1); });

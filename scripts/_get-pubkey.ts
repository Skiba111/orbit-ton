/**
 * Utility: print Ed25519 public key (hex) from a mnemonic.
 *
 * Usage:
 *   npx ts-node scripts/_get-pubkey.ts "word1 word2 ... word24"
 *
 * Output:
 *   Public key (hex): 52dfadb8e95cfce76eb724f79758...
 *
 * Use the result as:
 *   FEE_COLLECTOR_PUBKEY=<hex>  (in .env.local)
 *   RELAYER_PUBKEY=<hex>        (in .env.local)
 */

import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4, WalletContractV5R1 } from "@ton/ton";

async function main() {
    const mnemonic = process.argv[2];
    if (!mnemonic) {
        console.error("Usage: npx ts-node scripts/_get-pubkey.ts \"word1 word2 ... word24\"");
        process.exit(1);
    }

    const words = mnemonic.trim().split(/\s+/);
    if (words.length !== 24) {
        console.error(`Expected 24 words, got ${words.length}`);
        process.exit(1);
    }

    const kp      = await mnemonicToPrivateKey(words);
    const pubkey  = Buffer.from(kp.publicKey);

    const v4  = WalletContractV4.create({ workchain: 0, publicKey: pubkey });
    const v5  = WalletContractV5R1.create({
        workchain: 0, publicKey: pubkey,
        walletId: { networkGlobalId: -239 }, // mainnet
    });

    console.log("Public key (hex) :", pubkey.toString("hex"));
    console.log("Wallet v4 address:", v4.address.toString({ bounceable: false }));
    console.log("Wallet v5 address:", v5.address.toString({ bounceable: false }));
    console.log("\nTop up the address matching your WALLET_VERSION in .env");
}

main().catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
});

// Compute and print bytecode hashes for all ORBIT contracts.
// Usage: npx ts-node scripts/_compute-hashes.ts

import { createHash } from "crypto";
import { compileTolk } from "../tests/helpers/compileTolk";

const contracts = ["subscription", "factory", "registry", "fee-collector"] as const;

(async () => {
    for (const name of contracts) {
        const cell = await compileTolk(name);
        const boc  = cell.toBoc();
        const sha256    = createHash("sha256").update(boc).digest("hex");
        const codeHash  = cell.hash().toString("hex");
        const bocLen    = boc.length;
        console.log(`${name}:`);
        console.log(`  code_hash (SHA256 of StateInit code cell): ${codeHash}`);
        console.log(`  boc_sha256 (SHA256 of serialised BOC):     ${sha256}`);
        console.log(`  boc_size:  ${bocLen} bytes`);
        console.log();
    }
})();

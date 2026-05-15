/**
 * Monkey-patches @ton/core to add domainSign() which was added in v0.57+.
 * Must be imported before any @ton/ton wallet code.
 *
 * When domain is undefined (standard wallet signing), domainSign is just
 * a regular Ed25519 signature over the data hash — same as sign().
 */

import { sign } from "@ton/crypto";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require("@ton/core") as Record<string, unknown>;

if (!core["domainSign"]) {
    core["domainSign"] = (args: { secretKey: Buffer; data: Buffer; domain?: string }) => {
        if (args.domain) {
            // Domain-separated signing (TON Connect etc.) — prepend domain prefix
            const domainBuf = Buffer.from(args.domain, "utf8");
            const prefix    = Buffer.allocUnsafe(2 + 4 + domainBuf.length);
            prefix.writeUInt16BE(0xffff, 0);
            prefix.writeUInt32BE(domainBuf.length, 2);
            domainBuf.copy(prefix, 6);
            return sign(Buffer.concat([prefix, args.data]), args.secretKey);
        }
        // No domain — plain signature (standard wallet V1-V5R1 external msgs)
        return sign(args.data, args.secretKey);
    };
}

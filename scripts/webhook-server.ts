/**
 * ORBIT webhook receiver.
 *
 * Receives POST /orbit/webhook from the relayer after every confirmed charge.
 * Verifies the shared secret, logs the event, and can be extended with
 * custom business logic (DB writes, access provisioning, Telegram alerts, etc.).
 *
 * Start:
 *   ts-node scripts/webhook-server.ts
 *
 * Environment variables:
 *   WEBHOOK_PORT    — port to listen on (default: 3001)
 *   WEBHOOK_SECRET  — shared HMAC-SHA256 signing secret; relayer must send
 *                     X-Orbit-Signature: sha256=<hex(hmac(secret, body))>
 *   LOG_FILE        — path to append charge log (default: data/charges.log)
 */

import * as dotenv from "dotenv";
dotenv.config();

import * as http from "http";
import * as fs   from "fs";
import * as path from "path";
import { createHmac, timingSafeEqual } from "crypto";

const PORT    = parseInt(process.env.WEBHOOK_PORT   ?? "3001", 10);
const SECRET  = process.env.WEBHOOK_SECRET          ?? "";
const LOG_DIR = path.join(__dirname, "../data");
const LOG_FILE = process.env.LOG_FILE ?? path.join(LOG_DIR, "charges.log");

// Ensure data directory exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

interface ChargeEvent {
    event:      string;
    address:    string;  // Subscription contract address
    seqno_from: number;
    seqno_to:   number;
    timestamp:  number;
}

function log(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + "\n");
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end",  () => resolve(body));
        req.on("error", reject);
    });
}

// ── Business logic ────────────────────────────────────────────────────────────
// Extend this function with your own logic:
//   - Write to PostgreSQL / MongoDB
//   - Grant access to a user in your system
//   - Send a Telegram notification
//   - Call an external API
async function onChargeConfirmed(event: ChargeEvent): Promise<void> {
    log(`CHARGE_CONFIRMED address=${event.address} seqno=${event.seqno_from}→${event.seqno_to}`);

    // TODO: add your business logic here
    // Example: grant 30-day access to user with subscriptionAddress === event.address
    // const user = await db.users.findOne({ subscriptionAddress: event.address });
    // if (user) await grantAccess(user.id, 30);
}
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
        return;
    }

    // Webhook endpoint
    if (req.method === "POST" && req.url === "/orbit/webhook") {
        // 1. Read raw body (needed BEFORE signature verification so we sign the
        //    exact bytes the sender hashed — JSON.stringify can reorder keys).
        let rawBody: string;
        try {
            rawBody = await readBody(req);
        } catch {
            res.writeHead(400);
            res.end("Bad Request");
            return;
        }

        // 2. Verify HMAC-SHA256 signature (L7).  Header format: "sha256=<hex>".
        if (SECRET) {
            const provided = String(req.headers["x-orbit-signature"] ?? "");
            const expected = "sha256=" + createHmac("sha256", SECRET).update(rawBody).digest("hex");
            const pBuf = Buffer.from(provided);
            const eBuf = Buffer.from(expected);
            if (pBuf.length !== eBuf.length || !timingSafeEqual(pBuf, eBuf)) {
                log(`REJECTED webhook from ${req.socket.remoteAddress} — bad signature`);
                res.writeHead(401);
                res.end("Unauthorized");
                return;
            }
        }

        // 3. Parse JSON
        let event: ChargeEvent;
        try {
            event = JSON.parse(rawBody) as ChargeEvent;
        } catch {
            res.writeHead(400);
            res.end("Bad Request");
            return;
        }

        // 3. Dispatch
        try {
            if (event.event === "charge.success") {
                await onChargeConfirmed(event);
            } else {
                log(`UNKNOWN event type: ${event.event}`);
            }
            res.writeHead(200);
            res.end("OK");
        } catch (err) {
            log(`ERROR handling webhook: ${(err as Error).message}`);
            res.writeHead(500);
            res.end("Internal Server Error");
        }
        return;
    }

    res.writeHead(404);
    res.end("Not Found");
});

server.listen(PORT, () => {
    log(`Webhook server listening on port ${PORT}`);
    if (!SECRET) {
        log("WARNING: WEBHOOK_SECRET is not set — requests are not authenticated!");
    }
});

process.on("SIGTERM", () => { log("Shutting down…"); server.close(); });
process.on("SIGINT",  () => { log("Shutting down…"); server.close(); });

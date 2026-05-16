/**
 * ORBIT service registration script.
 *
 * Called by service operators (mini-app developers) who want to integrate
 * ORBIT subscriptions into their product.
 *
 * Sends OP_REGISTRY_REGISTER to the Registry, which deploys a Factory for
 * the sender with ORBIT's enforced fee settings baked in.
 *
 * After registration the service operator can:
 *   1. Add plans via OP_ADD_PLAN on their Factory
 *   2. Point their mini-app to their Factory address
 *   3. Subscribers send OP_SUBSCRIBE to the Factory
 *
 * Usage:
 *   ts-node scripts/register-service.ts
 *
 * Required env vars (.env):
 *   WALLET_MNEMONIC or MNEMONICS  — 24-word service operator mnemonic
 *   REGISTRY_ADDRESS              — ORBIT Registry contract address
 *   TONCENTER_API_KEY             — TonCenter API key
 *   NETWORK                       — testnet | mainnet
 *   WALLET_VERSION                — v4 | v5 (default: v5)
 */

import * as dotenv from "dotenv";
dotenv.config();

import "./patch-ton-core";

import { mnemonicToPrivateKey, sign } from "@ton/crypto";

(require("@ton/core") as any).domainSign ??= (args: {
    data: Buffer | Uint8Array;
    secretKey: Buffer;
    domain?: string;
}) => {
    if (args.domain) {
        const d   = Buffer.from(args.domain, "utf8");
        const len = Buffer.allocUnsafe(4);
        len.writeUInt32BE(d.length, 0);
        return sign(Buffer.concat([Buffer.from([0xff, 0xff]), len, d, Buffer.from(args.data)]), args.secretKey);
    }
    return sign(Buffer.from(args.data), args.secretKey);
};

import {
    beginCell, Address, toNano, Cell,
    storeMessage, storeMessageRelaxed, internal, external, SendMode,
} from "@ton/core";
import { WalletContractV4, WalletContractV5R1 } from "@ton/ton";
import { RegistryOps } from "../wrappers/Registry";

// ── Config ─────────────────────────────────────────────────────────────────────

const NETWORK           = process.env.NETWORK           ?? "testnet";
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY ?? "";
const WALLET_MNEMONIC   = process.env.WALLET_MNEMONIC   ?? process.env.MNEMONICS ?? "";
const REGISTRY_ADDRESS  = process.env.REGISTRY_ADDRESS  ?? "";
const WALLET_VERSION    = (process.env.WALLET_VERSION   ?? "v5").toLowerCase();

const NETWORK_GLOBAL_ID = NETWORK === "mainnet" ? -239 : -3;

const API_BASE = NETWORK === "mainnet"
    ? "https://toncenter.com/api/v2"
    : "https://testnet.toncenter.com/api/v2";

const HTTP_HEADERS: Record<string, string> = { "Content-Type": "application/json" };
if (TONCENTER_API_KEY) HTTP_HEADERS["X-API-KEY"] = TONCENTER_API_KEY;

// ── TonCenter helpers ──────────────────────────────────────────────────────────

async function getSeqno(addr: Address): Promise<number> {
    const res  = await fetch(`${API_BASE}/runGetMethod`, {
        method: "POST", headers: HTTP_HEADERS,
        body: JSON.stringify({ address: addr.toString(), method: "seqno", stack: [] }),
    });
    const json = await res.json() as {
        ok: boolean;
        result?: { stack: [string, string][]; exit_code: number };
    };
    if (!json.ok || !json.result || json.result.exit_code !== 0) return 0;
    if (!json.result.stack?.length) return 0;
    return parseInt(json.result.stack[0][1], 16);
}

async function isDeployed(addr: Address): Promise<boolean> {
    const res  = await fetch(`${API_BASE}/getAddressState?address=${addr.toString()}`, { headers: HTTP_HEADERS });
    const json = await res.json() as { ok: boolean; result?: string };
    return json.ok && json.result === "active";
}

async function sendBoc(boc: string): Promise<void> {
    const res  = await fetch(`${API_BASE}/sendBoc`, {
        method: "POST", headers: HTTP_HEADERS,
        body: JSON.stringify({ boc }),
    });
    const json = await res.json() as { ok: boolean; error?: string };
    if (!json.ok) throw new Error(`sendBoc failed: ${json.error ?? JSON.stringify(json)}`);
}

async function runGetMethod(addr: Address, method: string, stack: unknown[]): Promise<string[][]> {
    const res  = await fetch(`${API_BASE}/runGetMethod`, {
        method: "POST", headers: HTTP_HEADERS,
        body: JSON.stringify({ address: addr.toString(), method, stack }),
    });
    const json = await res.json() as {
        ok: boolean;
        result?: { stack: string[][]; exit_code: number; error?: string };
    };
    if (!json.ok || !json.result || json.result.exit_code !== 0) {
        throw new Error(`get_method failed: ${json.result?.error ?? JSON.stringify(json)}`);
    }
    return json.result.stack as string[][];
}

async function waitTx(expectedSeqno: number, walletAddr: Address, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    process.stdout.write("  Waiting for tx");
    while (Date.now() < deadline) {
        const seqno = await getSeqno(walletAddr);
        if (seqno >= expectedSeqno) { console.log(" ✅"); return; }
        await new Promise(r => setTimeout(r, 3_000));
        process.stdout.write(".");
    }
    throw new Error("\nTimeout — transaction not confirmed");
}

async function waitFactoryDeployed(registryAddr: Address, serviceAddr: Address, timeoutMs = 90_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    process.stdout.write("  Waiting for Factory");

    // Build the address slice argument for the getter
    const addrCell = beginCell().storeAddress(serviceAddr).endCell().toBoc().toString("hex");
    const stackArg = [["tvm.Slice", addrCell]];

    while (Date.now() < deadline) {
        try {
            const stack = await runGetMethod(registryAddr, "get_factory_address", stackArg);
            if (stack.length > 0) {
                const factoryAddr = stack[0][1];
                console.log(" ✅");
                return factoryAddr;
            }
        } catch {
            // Not yet registered — keep waiting
        }
        await new Promise(r => setTimeout(r, 3_000));
        process.stdout.write(".");
    }
    throw new Error("\nTimeout — Factory not detected in Registry");
}

// ── Message builder ────────────────────────────────────────────────────────────

interface MsgSpec {
    to:     Address;
    value:  bigint;
    bounce: boolean;
    body?:  Cell;
}

const WALLET_V4_ID = 698983191;

function buildV4TransferBody(seqno: number, secretKey: Buffer, msgs: MsgSpec[]): Cell {
    let inner = beginCell()
        .storeUint(WALLET_V4_ID, 32)
        .storeUint(Math.floor(Date.now() / 1000) + 60, 32)
        .storeUint(seqno, 32)
        .storeUint(0, 8);

    for (const m of msgs) {
        const msgCell = beginCell()
            .store(storeMessageRelaxed(internal({
                to: m.to, value: m.value, bounce: m.bounce,
                body: m.body ?? beginCell().endCell(),
            })))
            .endCell();
        inner = inner.storeUint(SendMode.PAY_GAS_SEPARATELY, 8).storeRef(msgCell) as typeof inner;
    }

    const innerCell = inner.endCell();
    const sig       = sign(innerCell.hash(), secretKey);
    return beginCell().storeBuffer(sig).storeSlice(innerCell.beginParse()).endCell();
}

function buildV5R1TransferBody(
    walletContract: WalletContractV5R1,
    seqno: number, secretKey: Buffer, msgs: MsgSpec[],
): Cell {
    return walletContract.createTransfer({
        seqno, secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: msgs.map(m => internal({
            to: m.to, value: m.value, bounce: m.bounce, body: m.body,
        })),
    });
}

async function sendTx(
    walletAddr: Address,
    walletInit: { code: Cell; data: Cell } | undefined,
    seqno: number, secretKey: Buffer, msgs: MsgSpec[],
    walletV5?: WalletContractV5R1,
): Promise<void> {
    const body   = WALLET_VERSION === "v4"
        ? buildV4TransferBody(seqno, secretKey, msgs)
        : buildV5R1TransferBody(walletV5!, seqno, secretKey, msgs);
    const extMsg = external({ to: walletAddr, init: seqno === 0 ? walletInit : undefined, body });
    const boc    = beginCell().store(storeMessage(extMsg)).endCell().toBoc().toString("base64");
    await sendBoc(boc);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
    if (!WALLET_MNEMONIC)  throw new Error("Set WALLET_MNEMONIC (or MNEMONICS) in .env");
    if (!REGISTRY_ADDRESS) throw new Error("Set REGISTRY_ADDRESS in .env");

    const registryAddr = Address.parse(REGISTRY_ADDRESS);

    console.log(`\n🏗️  ORBIT Service Registration — ${NETWORK.toUpperCase()}\n`);
    console.log(`Registry : ${registryAddr.toString()}`);

    // Derive keys
    const kp        = await mnemonicToPrivateKey(WALLET_MNEMONIC.split(" "));
    const secretKey = Buffer.from(kp.secretKey);

    let walletAddr: Address;
    let walletInit: { code: Cell; data: Cell };
    let walletContractV5: WalletContractV5R1 | undefined;

    if (WALLET_VERSION === "v4") {
        const w    = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
        walletAddr = w.address;
        walletInit = w.init as { code: Cell; data: Cell };
    } else {
        walletContractV5 = WalletContractV5R1.create({
            workchain: 0, publicKey: kp.publicKey,
            walletId: { networkGlobalId: NETWORK_GLOBAL_ID },
        });
        walletAddr = walletContractV5.address;
        walletInit = walletContractV5.init as { code: Cell; data: Cell };
    }

    console.log(`Service wallet : ${walletAddr.toString()}\n`);

    // Check Registry is deployed
    if (!(await isDeployed(registryAddr))) {
        throw new Error("Registry contract is not deployed. Check REGISTRY_ADDRESS in .env");
    }

    // Send OP_REGISTRY_REGISTER
    const registerBody = beginCell()
        .storeUint(RegistryOps.REGISTER, 32)
        .storeUint(0, 64)  // query_id
    .endCell();

    const seqno = await getSeqno(walletAddr);
    console.log(`Sending OP_REGISTRY_REGISTER (value: 0.3 TON)…`);
    await sendTx(walletAddr, walletInit, seqno, secretKey, [{
        to:     registryAddr,
        value:  toNano("0.3"),
        bounce: true,
        body:   registerBody,
    }], walletContractV5);

    // Wait for tx confirmation
    await waitTx(seqno + 1, walletAddr);

    // Wait for Factory to appear in Registry
    console.log("Checking Registry for your Factory…");
    const factoryAddrHex = await waitFactoryDeployed(registryAddr, walletAddr);

    // Pretty-print the factory address
    // TonCenter returns the address in hex; convert to human-readable
    let factoryAddrStr = factoryAddrHex;
    try {
        // Stack entry format from TonCenter: ["tvm.Slice", "hex_boc"]
        // The hex_boc contains the address slice — parse it
        const sliceCell = Cell.fromBoc(Buffer.from(factoryAddrHex, "hex"))[0];
        const slice     = sliceCell.beginParse();
        const addr      = slice.loadAddress();
        factoryAddrStr  = addr.toString();
    } catch {
        // If parsing fails, use raw hex
    }

    console.log("\n╔══════════════════════════════════════════════════════════════════╗");
    console.log("║               Service Registration Complete ✅                   ║");
    console.log("╠══════════════════════════════════════════════════════════════════╣");
    console.log(`║  Network      : ${NETWORK}`);
    console.log(`║  Your wallet  : ${walletAddr.toString()}`);
    console.log(`║  Factory addr : ${factoryAddrStr}`);
    console.log("╠══════════════════════════════════════════════════════════════════╣");
    console.log("║  Next steps:                                                     ║");
    console.log("║  1. Set FACTORY_ADDRESS=" + factoryAddrStr.slice(0, 20) + "... in .env");
    console.log("║  2. Add plans via OP_ADD_PLAN on your Factory                    ║");
    console.log("║  3. Point your mini-app to FACTORY_ADDRESS                       ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝\n");
}

main().catch(err => {
    console.error("\n❌ Registration failed:", err.message);
    process.exit(1);
});

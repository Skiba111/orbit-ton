/**
 * ORBIT Registry deploy script.
 *
 * Deploys the Registry contract — the ORBIT platform entry point.
 * After deployment, service operators register via scripts/register-service.ts
 * and receive their own Factory with enforced ORBIT fee settings.
 *
 * Deploys:
 *   1. FeeCollector — collects platform fees with 24h withdrawal timelock
 *   2. Registry     — stores factory/subscription code + fee settings;
 *                     deploys a Factory per service operator on demand
 *
 * Usage:
 *   ts-node scripts/deploy-registry.ts
 *
 * Required env vars (.env):
 *   WALLET_MNEMONIC or MNEMONICS  — 24-word deployer wallet mnemonic
 *   FEE_COLLECTOR_PUBKEY          — hex Ed25519 public key for fee withdrawal (cold key)
 *   RELAYER_PUBKEY                — hex Ed25519 public key for charge signing
 *   TONCENTER_API_KEY             — TonCenter API key
 *   NETWORK                       — testnet | mainnet
 *   WALLET_VERSION                — v4 | v5 (default: v5)
 *   PLATFORM_FEE_BPS              — platform fee bps for Registry-deployed Factories (default: 0 = no extra fee)
 */

import * as dotenv from "dotenv";
dotenv.config();

import "./patch-ton-core";

import * as readline from "readline";
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
import { compileTolk }    from "../tests/helpers/compileTolk";
import { FeeCollector }   from "../wrappers/FeeCollector";
import { Registry }       from "../wrappers/Registry";

// ── Config ─────────────────────────────────────────────────────────────────────

const NETWORK           = process.env.NETWORK           ?? "testnet";
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY ?? "";
const WALLET_MNEMONIC   = process.env.WALLET_MNEMONIC   ?? process.env.MNEMONICS ?? "";
const FEE_COLLECTOR_HEX = process.env.FEE_COLLECTOR_PUBKEY ?? "";
const RELAYER_HEX       = process.env.RELAYER_PUBKEY    ?? "";
const WALLET_VERSION    = (process.env.WALLET_VERSION   ?? "v5").toLowerCase();
const PLATFORM_FEE_BPS  = parseInt(process.env.PLATFORM_FEE_BPS ?? "0", 10);

const NETWORK_GLOBAL_ID = NETWORK === "mainnet" ? -239 : -3;

const API_BASE = NETWORK === "mainnet"
    ? "https://toncenter.com/api/v2"
    : "https://testnet.toncenter.com/api/v2";

const HTTP_HEADERS: Record<string, string> = { "Content-Type": "application/json" };
if (TONCENTER_API_KEY) HTTP_HEADERS["X-API-KEY"] = TONCENTER_API_KEY;

// ── Readline ───────────────────────────────────────────────────────────────────

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, a => resolve(a.trim())));

// ── TonCenter helpers ──────────────────────────────────────────────────────────

async function getSeqno(addr: Address): Promise<number> {
    const res  = await fetch(`${API_BASE}/runGetMethod`, {
        method:  "POST",
        headers: HTTP_HEADERS,
        body:    JSON.stringify({ address: addr.toString(), method: "seqno", stack: [] }),
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
        method:  "POST",
        headers: HTTP_HEADERS,
        body:    JSON.stringify({ boc }),
    });
    const json = await res.json() as { ok: boolean; error?: string };
    if (!json.ok) throw new Error(`sendBoc failed: ${json.error ?? JSON.stringify(json)}`);
}

async function getWalletState(addr: Address): Promise<{ balance: string; state: string; seqno: number }> {
    const [balRes, seqno] = await Promise.all([
        fetch(`${API_BASE}/getAddressInformation?address=${addr.toString()}`, { headers: HTTP_HEADERS })
            .then(r => r.json() as Promise<{ ok: boolean; result?: { balance: string; state: string } }>),
        getSeqno(addr),
    ]);
    const balance = balRes.ok ? (balRes.result?.balance ?? "0") : "0";
    const state   = balRes.ok ? (balRes.result?.state   ?? "unknown") : "unknown";
    return { balance, state, seqno };
}

async function waitDeployed(addr: Address, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    process.stdout.write("  Waiting");
    while (Date.now() < deadline) {
        if (await isDeployed(addr)) { console.log(" ✅"); return; }
        await new Promise(r => setTimeout(r, 3_000));
        process.stdout.write(".");
    }
    throw new Error(`\nTimeout — contract not deployed: ${addr.toString()}`);
}

// ── Message helpers ────────────────────────────────────────────────────────────

interface MsgSpec {
    to:     Address;
    value:  bigint;
    bounce: boolean;
    init?:  { code: Cell; data: Cell };
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
                to: m.to, value: m.value, bounce: m.bounce, init: m.init,
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
            to: m.to, value: m.value, bounce: m.bounce, init: m.init, body: m.body,
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
    if (!WALLET_MNEMONIC)   throw new Error("Set WALLET_MNEMONIC (or MNEMONICS) in .env");
    if (!FEE_COLLECTOR_HEX) throw new Error("Set FEE_COLLECTOR_PUBKEY in .env");
    if (!RELAYER_HEX)       throw new Error("Set RELAYER_PUBKEY in .env");

    console.log(`\n🚀  ORBIT Registry Deploy — ${NETWORK.toUpperCase()} (wallet ${WALLET_VERSION.toUpperCase()})\n`);
    console.log(`Platform fee: ${PLATFORM_FEE_BPS} bps (${PLATFORM_FEE_BPS / 100}%)\n`);

    // Derive deployer keys
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

    console.log(`Deployer wallet : ${walletAddr.toString()}`);

    const ws = await getWalletState(walletAddr);
    console.log(`  Balance : ${Number(ws.balance) / 1e9} TON`);
    console.log(`  State   : ${ws.state}`);
    console.log(`  Seqno   : ${ws.seqno}`);
    if (Number(ws.balance) < 1_000_000_000) {
        throw new Error("Deployer wallet has < 1 TON — please top it up first");
    }

    // ── Compile ───────────────────────────────────────────────────────────────

    console.log("\n📦 Compiling contracts (this takes ~20 s)…");
    const [feeCollectorCode, subCode, factoryCode, registryCode] = await Promise.all([
        compileTolk("fee-collector"),
        compileTolk("subscription"),
        compileTolk("factory"),
        compileTolk("registry"),
    ]);
    console.log("✅ Compiled\n");

    // ── Step 1: FeeCollector ──────────────────────────────────────────────────

    const feeCollector = FeeCollector.createFromConfig(
        { ownerPubkey: BigInt("0x" + FEE_COLLECTOR_HEX) },
        feeCollectorCode,
    );
    console.log(`FeeCollector : ${feeCollector.address.toString()}`);

    // Protocol fee collector = the FeeCollector contract itself.
    // Shown above so the user can verify before proceeding.
    // To override (e.g. use a separate cold wallet), enter a different address.
    const protocolDefault = feeCollector.address.toString();
    const protocolStr = await ask(
        `\nProtocol fee collector address [default: FeeCollector above]\n> `
    );
    const protocolFeeCollector = Address.parse(protocolStr.trim() || protocolDefault);

    if (await isDeployed(feeCollector.address)) {
        console.log("✅ Already deployed — skipping");
    } else {
        const seqno = await getSeqno(walletAddr);
        await sendTx(walletAddr, walletInit, seqno, secretKey, [{
            to: feeCollector.address, value: toNano("1"),
            bounce: false, init: feeCollector.init as { code: Cell; data: Cell },
        }], walletContractV5);
        await waitDeployed(feeCollector.address);
    }

    // ── Step 2: Registry ──────────────────────────────────────────────────────

    const registry = Registry.createFromConfig({
        relayerPubkey:        BigInt("0x" + RELAYER_HEX),
        platformFeeBps:       PLATFORM_FEE_BPS,
        ownerAddr:            walletAddr,
        feeCollector:         feeCollector.address,
        protocolFeeCollector: protocolFeeCollector,
        factoryCode,
        subscriptionCode:     subCode,
    }, registryCode);

    console.log(`\nRegistry : ${registry.address.toString()}`);

    if (await isDeployed(registry.address)) {
        console.log("✅ Already deployed — skipping");
    } else {
        const seqno = await getSeqno(walletAddr);
        await sendTx(walletAddr, walletInit, seqno, secretKey, [{
            to: registry.address, value: toNano("0.5"),
            bounce: false, init: registry.init as { code: Cell; data: Cell },
        }], walletContractV5);
        await waitDeployed(registry.address);
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    console.log("\n╔══════════════════════════════════════════════════════════════════╗");
    console.log("║              ORBIT Registry Deployment Complete ✅               ║");
    console.log("╠══════════════════════════════════════════════════════════════════╣");
    console.log(`║  Network        : ${NETWORK}`);
    console.log(`║  FeeCollector   : ${feeCollector.address.toString()}`);
    console.log(`║  Registry       : ${registry.address.toString()}`);
    console.log(`║  Platform fee   : ${PLATFORM_FEE_BPS} bps (${PLATFORM_FEE_BPS / 100}%)`);
    console.log("╠══════════════════════════════════════════════════════════════════╣");
    console.log("║  → Share REGISTRY_ADDRESS with service operators                ║");
    console.log("║  → They register with: ts-node scripts/register-service.ts      ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝\n");

    rl.close();
}

main().catch(err => {
    console.error("\n❌ Deploy failed:", err.message);
    rl.close();
    process.exit(1);
});

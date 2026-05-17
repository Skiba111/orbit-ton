/**
 * ORBIT — Cancel subscription and refund deposit.
 *
 * Sends OP_CANCEL to a Subscription contract.
 * Must be called by the subscriber (owner) wallet.
 * Deposit is returned to subscriber after cancellation.
 *
 * Usage:
 *   ts-node scripts/cancel-subscription.ts
 *
 * Required env vars:
 *   WALLET_MNEMONIC      — subscriber wallet
 *   SUBSCRIPTION_ADDRESS — address of the subscription contract to cancel
 *   TONCENTER_API_KEY    — TonCenter API key
 *   NETWORK              — testnet | mainnet
 *   WALLET_VERSION       — v4 | v5 (default: v5)
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

const NETWORK             = process.env.NETWORK              ?? "testnet";
const TONCENTER_API_KEY   = process.env.TONCENTER_API_KEY    ?? "";
const WALLET_MNEMONIC     = process.env.WALLET_MNEMONIC      ?? process.env.MNEMONICS ?? "";
const SUBSCRIPTION_ADDRESS = process.env.SUBSCRIPTION_ADDRESS ?? "";
const WALLET_VERSION      = (process.env.WALLET_VERSION      ?? "v5").toLowerCase();

const NETWORK_GLOBAL_ID = NETWORK === "mainnet" ? -239 : -3;
const API_BASE = NETWORK === "mainnet"
    ? "https://toncenter.com/api/v2"
    : "https://testnet.toncenter.com/api/v2";

const HTTP_HEADERS: Record<string, string> = { "Content-Type": "application/json" };
if (TONCENTER_API_KEY) HTTP_HEADERS["X-API-KEY"] = TONCENTER_API_KEY;

const OP_CANCEL = 0x4F520010;

async function getSeqno(addr: Address): Promise<number> {
    const res  = await fetch(`${API_BASE}/runGetMethod`, {
        method: "POST", headers: HTTP_HEADERS,
        body: JSON.stringify({ address: addr.toString(), method: "seqno", stack: [] }),
    });
    const json = await res.json() as { ok: boolean; result?: { stack: [string,string][]; exit_code: number } };
    if (!json.ok || !json.result || json.result.exit_code !== 0) return 0;
    return parseInt(json.result.stack?.[0]?.[1] ?? "0", 16);
}

async function getBalance(addr: Address): Promise<bigint> {
    const res  = await fetch(`${API_BASE}/getAddressInformation?address=${addr.toString()}`, { headers: HTTP_HEADERS });
    const json = await res.json() as { ok: boolean; result?: { balance: string } };
    return BigInt(json.result?.balance ?? "0");
}

async function sendBoc(boc: string): Promise<void> {
    const res  = await fetch(`${API_BASE}/sendBoc`, {
        method: "POST", headers: HTTP_HEADERS,
        body: JSON.stringify({ boc }),
    });
    const json = await res.json() as { ok: boolean; error?: string };
    if (!json.ok) throw new Error(`sendBoc failed: ${json.error ?? JSON.stringify(json)}`);
}

async function waitTx(expectedSeqno: number, walletAddr: Address, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    process.stdout.write("  Waiting");
    while (Date.now() < deadline) {
        if (await getSeqno(walletAddr) >= expectedSeqno) { console.log(" ✅"); return; }
        await new Promise(r => setTimeout(r, 3_000));
        process.stdout.write(".");
    }
    throw new Error("\nTimeout");
}

const WALLET_V4_ID = 698983191;

function buildV4Body(seqno: number, secretKey: Buffer, to: Address, value: bigint, body: Cell): Cell {
    const msgCell = beginCell().store(storeMessageRelaxed(internal({ to, value, bounce: true, body }))).endCell();
    const inner   = beginCell()
        .storeUint(WALLET_V4_ID, 32)
        .storeUint(Math.floor(Date.now() / 1000) + 60, 32)
        .storeUint(seqno, 32)
        .storeUint(0, 8)
        .storeUint(SendMode.PAY_GAS_SEPARATELY, 8)
        .storeRef(msgCell)
    .endCell();
    return beginCell().storeBuffer(sign(inner.hash(), secretKey)).storeSlice(inner.beginParse()).endCell();
}

function buildV5Body(wallet: WalletContractV5R1, seqno: number, secretKey: Buffer, to: Address, value: bigint, body: Cell): Cell {
    return wallet.createTransfer({
        seqno, secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({ to, value, bounce: true, body })],
    });
}

async function main() {
    if (!WALLET_MNEMONIC)      throw new Error("Set WALLET_MNEMONIC in .env");
    if (!SUBSCRIPTION_ADDRESS) throw new Error("Set SUBSCRIPTION_ADDRESS env var");

    const subAddr = Address.parse(SUBSCRIPTION_ADDRESS);
    const kp      = await mnemonicToPrivateKey(WALLET_MNEMONIC.split(" "));
    const secretKey = Buffer.from(kp.secretKey);

    let walletAddr: Address;
    let walletInit: { code: Cell; data: Cell };
    let walletV5:   WalletContractV5R1 | undefined;

    if (WALLET_VERSION === "v4") {
        const w  = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
        walletAddr = w.address; walletInit = w.init as { code: Cell; data: Cell };
    } else {
        walletV5   = WalletContractV5R1.create({ workchain: 0, publicKey: kp.publicKey, walletId: { networkGlobalId: NETWORK_GLOBAL_ID } });
        walletAddr = walletV5.address; walletInit = walletV5.init as { code: Cell; data: Cell };
    }

    const subBalance = await getBalance(subAddr);

    console.log(`\n❌  ORBIT Cancel Subscription — ${NETWORK.toUpperCase()}\n`);
    console.log(`Subscription : ${subAddr.toString()}`);
    console.log(`Sub balance  : ${(Number(subBalance) / 1e9).toFixed(3)} TON`);
    console.log(`Subscriber   : ${walletAddr.toString()}\n`);

    const body = beginCell()
        .storeUint(OP_CANCEL, 32)
        .storeUint(0, 64)  // query_id
    .endCell();

    const seqno  = await getSeqno(walletAddr);
    const txBody = WALLET_VERSION === "v4"
        ? buildV4Body(seqno, secretKey, subAddr, toNano("0.05"), body)
        : buildV5Body(walletV5!, seqno, secretKey, subAddr, toNano("0.05"), body);

    const extMsg = external({ to: walletAddr, init: seqno === 0 ? walletInit : undefined, body: txBody });
    const boc    = beginCell().store(storeMessage(extMsg)).endCell().toBoc().toString("base64");

    console.log("Sending OP_CANCEL…");
    await sendBoc(boc);
    await waitTx(seqno + 1, walletAddr);

    console.log("\n✅  Subscription cancelled — deposit will be refunded to subscriber wallet.");
    console.log("   Check balance in 10-15 seconds.\n");
}

main().catch(err => {
    console.error("\n❌ Failed:", err.message);
    process.exit(1);
});

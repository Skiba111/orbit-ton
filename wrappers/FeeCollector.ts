import {
    Address, beginCell, Cell, Contract, ContractProvider,
    contractAddress, Sender, SendMode, toNano,
} from "@ton/core";
import { sign } from "@ton/crypto";

export const FeeCollectorOps = {
    COLLECT:         0x4F520040, // phase 1: schedule withdrawal (starts 24 h timelock)
    CONFIRM_COLLECT: 0x4F520041, // phase 2: execute after timelock expires
    FEE_PAYMENT:     0x4F520021, // accepted from any subscription (fee accumulation)
} as const;

export interface FeeCollectorConfig {
    ownerPubkey: bigint;
}

// Empty pending-withdrawal cell (no pending withdrawal, matches empty_pending() in Tolk).
function buildEmptyPending(): Cell {
    return beginCell()
        .storeUint(0, 32)    // withdrawal_request_time = 0
        .storeCoins(0n)      // withdrawal_amount = 0
        .storeUint(0, 2)     // addr_none as withdrawal_dest
    .endCell();
}

// Storage layout (matches fee-collector.tolk):
//   Root: owner_pubkey(256) seqno(32) total_collected(coins)
//   Ref0: pending withdrawal cell
export function buildFeeCollectorData(cfg: FeeCollectorConfig): Cell {
    return beginCell()
        .storeUint(cfg.ownerPubkey, 256)
        .storeUint(0, 32)   // seqno = 0
        .storeCoins(0n)     // total_collected = 0
        .storeRef(buildEmptyPending())
    .endCell();
}

// Builds and signs an external message body for fee-collector ops.
// Layout: sig(512) seqno(32) timestamp(32) op(32) ...payload
function buildSignedExtMsg(
    seqno:     number,
    op:        number,
    payload:   Cell | null,
    secretKey: Buffer,
): Cell {
    let inner = beginCell()
        .storeUint(seqno,     32)
        .storeUint(Math.floor(Date.now() / 1000), 32)
        .storeUint(op,        32);

    if (payload) {
        inner = inner.storeSlice(payload.beginParse()) as typeof inner;
    }

    const innerCell = inner.endCell();
    const sig = sign(innerCell.hash(), secretKey);

    return beginCell()
        .storeBuffer(sig)
        .storeSlice(innerCell.beginParse())
    .endCell();
}

export class FeeCollector implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromConfig(cfg: FeeCollectorConfig, code: Cell, workchain = 0) {
        const data = buildFeeCollectorData(cfg);
        const initState = { code, data };
        return new FeeCollector(contractAddress(workchain, initState), initState);
    }

    static createFromAddress(address: Address) {
        return new FeeCollector(address);
    }

    // ── Deploy ───────────────────────────────────────────────────────────────

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell().endCell(),
        });
    }

    // ── Phase 1: schedule withdrawal ─────────────────────────────────────────
    //
    // Records the withdrawal intent and starts the 24-hour timelock.
    // Funds do NOT move yet.  To cancel a pending withdrawal, call again with
    // amount=0n.

    async sendCollect(
        provider:    ContractProvider,
        secretKey:   Buffer,
        destination: Address,
        amount:      bigint,  // 0n = withdraw all available above reserve
    ) {
        const seqno   = await this.getSeqno(provider);
        const payload = beginCell()
            .storeCoins(amount)
            .storeAddress(destination)
        .endCell();

        await provider.external(
            buildSignedExtMsg(seqno, FeeCollectorOps.COLLECT, payload, secretKey)
        );
    }

    // ── Phase 2: confirm and execute withdrawal ───────────────────────────────
    //
    // Executes the previously scheduled withdrawal after WITHDRAWAL_TIMELOCK_SEC
    // (24 h) has elapsed since the OP_COLLECT call.

    async sendConfirmCollect(
        provider:  ContractProvider,
        secretKey: Buffer,
    ) {
        const seqno = await this.getSeqno(provider);
        await provider.external(
            buildSignedExtMsg(seqno, FeeCollectorOps.CONFIRM_COLLECT, null, secretKey)
        );
    }

    // ── Getters ───────────────────────────────────────────────────────────────

    async getSeqno(provider: ContractProvider): Promise<number> {
        const result = await provider.get("get_seqno", []);
        return Number(result.stack.readBigNumber());
    }

    async getTotalCollected(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get("get_total_collected", []);
        return result.stack.readBigNumber();
    }

    async getBalanceAvailable(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get("get_balance_available", []);
        return result.stack.readBigNumber();
    }

    // Returns the pending withdrawal: { requestTime, amount, destHash }.
    // requestTime === 0 means no pending withdrawal.
    async getPendingWithdrawal(provider: ContractProvider): Promise<{
        requestTime: number;
        amount:      bigint;
        destHash:    bigint;
    }> {
        const result = await provider.get("get_pending_withdrawal", []);
        const stack  = result.stack;
        return {
            requestTime: Number(stack.readBigNumber()),
            amount:      stack.readBigNumber(),
            destHash:    stack.readBigNumber(),
        };
    }

    // Seconds remaining until the pending withdrawal can be confirmed.
    // Returns 0 if no pending withdrawal or timelock already expired.
    async getTimelockRemaining(provider: ContractProvider): Promise<number> {
        const result = await provider.get("get_timelock_remaining", []);
        return Number(result.stack.readBigNumber());
    }
}

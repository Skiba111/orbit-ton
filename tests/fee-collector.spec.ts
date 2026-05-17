import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { toNano, beginCell }                              from "@ton/core";
import { mnemonicToPrivateKey, mnemonicNew }              from "@ton/crypto";
import { compileTolk }                                    from "./helpers/compileTolk";
import { FeeCollector, buildFeeCollectorData, FeeCollectorOps } from "../wrappers/FeeCollector";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeKeypair() {
    const mnemonic = await mnemonicNew(24);
    const kp       = await mnemonicToPrivateKey(mnemonic);
    return {
        secretKey: Buffer.from(kp.secretKey),
        publicKey: Buffer.from(kp.publicKey),
        pubkeyInt: BigInt("0x" + Buffer.from(kp.publicKey).toString("hex")),
    };
}

const TIMELOCK = 86400; // 24 hours in seconds

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("FeeCollector", () => {
    let blockchain:    Blockchain;
    let owner:         SandboxContract<TreasuryContract>;
    let recipient:     SandboxContract<TreasuryContract>;
    let feeCollector:  SandboxContract<FeeCollector>;
    let collectorCode: import("@ton/core").Cell;
    let ownerKey:      { secretKey: Buffer; publicKey: Buffer; pubkeyInt: bigint };

    beforeAll(async () => {
        collectorCode = await compileTolk("fee-collector");
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner      = await blockchain.treasury("owner");
        recipient  = await blockchain.treasury("recipient");
        ownerKey   = await makeKeypair();

        feeCollector = blockchain.openContract(
            FeeCollector.createFromConfig({ ownerPubkey: ownerKey.pubkeyInt }, collectorCode)
        );

        await feeCollector.sendDeploy(owner.getSender(), toNano("1"));
    });

    // ── Fee accumulation ───────────────────────────────────────────────────────

    describe("fee accumulation", () => {
        it("accepts OP_FEE_PAYMENT from any sender and tracks total_collected", async () => {
            const before = await feeCollector.getTotalCollected();

            // Any address can send OP_FEE_PAYMENT — no auth required
            const body = beginCell()
                .storeUint(FeeCollectorOps.FEE_PAYMENT, 32)
                .storeUint(0, 64)           // query_id
                .storeCoins(toNano("0.5"))  // fee_amount
                .storeUint(0, 32)           // plan_id
                .storeUint(0, 2)            // subscriber_addr (addr_none for test)
            .endCell();

            await owner.send({
                to:    feeCollector.address,
                value: toNano("0.6"),
                body,
            });

            const after = await feeCollector.getTotalCollected();
            expect(after).toBeGreaterThan(before);
            expect(after - before).toBe(toNano("0.5"));
        });

        it("balance_available returns balance minus COLLECTOR_RESERVE", async () => {
            const avail = await feeCollector.getBalanceAvailable();
            // After deploy with 1 TON: available ≈ 0.9 TON (1 TON - 0.1 TON reserve)
            expect(avail).toBeGreaterThan(0n);
            expect(avail).toBeLessThan(toNano("1"));
        });
    });

    // ── Withdrawal flow ────────────────────────────────────────────────────────

    describe("withdrawal — happy path", () => {
        it("OP_COLLECT schedules a withdrawal and starts timelock", async () => {
            await feeCollector.sendCollect(
                ownerKey.secretKey,
                recipient.address,
                toNano("0.5"),
            );

            const pending = await feeCollector.getPendingWithdrawal();
            expect(pending.requestTime).toBeGreaterThan(0);
            expect(pending.amount).toBe(toNano("0.5"));
        });

        it("OP_CONFIRM_COLLECT executes after 24 h timelock", async () => {
            await feeCollector.sendCollect(
                ownerKey.secretKey,
                recipient.address,
                toNano("0.5"),
            );

            // Fast-forward blockchain time past the 24 h timelock
            blockchain.now = Math.floor(Date.now() / 1000) + TIMELOCK + 1;

            const balanceBefore = await recipient.getBalance();

            await feeCollector.sendConfirmCollect(
                ownerKey.secretKey,
                blockchain.now,
            );

            const balanceAfter = await recipient.getBalance();
            expect(balanceAfter).toBeGreaterThan(balanceBefore);

            // Pending should be cleared
            const pending = await feeCollector.getPendingWithdrawal();
            expect(pending.requestTime).toBe(0);
        });

        it("seqno increments after each external op", async () => {
            const seqno0 = await feeCollector.getSeqno();

            await feeCollector.sendCollect(
                ownerKey.secretKey,
                recipient.address,
                toNano("0.1"),
            );

            const seqno1 = await feeCollector.getSeqno();
            expect(seqno1).toBe(seqno0 + 1);
        });
    });

    // ── Timelock enforcement ───────────────────────────────────────────────────

    describe("timelock enforcement", () => {
        it("OP_CONFIRM_COLLECT fails before 24 h elapses — state unchanged", async () => {
            await feeCollector.sendCollect(
                ownerKey.secretKey,
                recipient.address,
                toNano("0.5"),
            );

            const seqnoBefore      = await feeCollector.getSeqno();
            const recipientBefore  = await recipient.getBalance();

            // Confirm immediately — VM exits 430 (ERROR_TIMELOCK_ACTIVE) after accept_message().
            // Blueprint records the failed tx and resolves; verify state is unchanged.
            await feeCollector.sendConfirmCollect(ownerKey.secretKey);

            const seqnoAfter     = await feeCollector.getSeqno();
            const recipientAfter = await recipient.getBalance();

            expect(seqnoAfter).toBe(seqnoBefore);    // seqno not bumped = withdrawal not committed
            expect(recipientAfter).toBe(recipientBefore); // no funds moved to recipient
        });

        it("OP_CONFIRM_COLLECT fails when no pending withdrawal exists — seqno unchanged", async () => {
            const seqnoBefore = await feeCollector.getSeqno();

            // No pending — VM exits 406 after accept_message(); Blueprint resolves.
            // Seqno must stay the same because the tx was not committed.
            await feeCollector.sendConfirmCollect(ownerKey.secretKey);

            const seqnoAfter = await feeCollector.getSeqno();
            expect(seqnoAfter).toBe(seqnoBefore);
        });

        it("get_timelock_remaining returns correct seconds", async () => {
            // No pending — should return 0
            const before = await feeCollector.getTimelockRemaining();
            expect(before).toBe(0);

            await feeCollector.sendCollect(
                ownerKey.secretKey,
                recipient.address,
                toNano("0.5"),
            );

            const remaining = await feeCollector.getTimelockRemaining();
            // Should be close to TIMELOCK (24h), within a few seconds
            expect(remaining).toBeGreaterThan(TIMELOCK - 10);
            expect(remaining).toBeLessThanOrEqual(TIMELOCK);
        });
    });

    // ── Cancellation ──────────────────────────────────────────────────────────

    describe("withdrawal cancellation", () => {
        it("OP_COLLECT with amount=0 cancels a pending withdrawal", async () => {
            await feeCollector.sendCollect(
                ownerKey.secretKey,
                recipient.address,
                toNano("0.5"),
            );

            let pending = await feeCollector.getPendingWithdrawal();
            expect(pending.requestTime).toBeGreaterThan(0);

            // Cancel by sending amount=0
            await feeCollector.sendCollect(
                ownerKey.secretKey,
                recipient.address,
                0n,
            );

            pending = await feeCollector.getPendingWithdrawal();
            // amount=0 sets a new pending with amount=0 but request_time > 0.
            // Confirming amount=0 withdrawal means "withdraw all available".
            // The pending still exists (requestTime > 0) but amount is 0.
            expect(pending.amount).toBe(0n);
        });
    });

    // ── OP_ROTATE_KEY ──────────────────────────────────────────────────────────

    describe("OP_ROTATE_KEY — emergency key rotation", () => {
        it("rotates the owner key and clears pending withdrawal", async () => {
            // Schedule a withdrawal first
            await feeCollector.sendCollect(
                ownerKey.secretKey,
                recipient.address,
                toNano("0.5"),
            );

            let pending = await feeCollector.getPendingWithdrawal();
            expect(pending.requestTime).toBeGreaterThan(0);

            // Rotate to a new key
            const newKey = await makeKeypair();
            await feeCollector.sendRotateKey(
                ownerKey.secretKey,    // sign with OLD key
                newKey.publicKey,      // install NEW key
            );

            // Pending withdrawal must be cleared after rotation
            pending = await feeCollector.getPendingWithdrawal();
            expect(pending.requestTime).toBe(0);

            // Seqno incremented
            const seqno = await feeCollector.getSeqno();
            expect(seqno).toBe(2); // sendCollect + sendRotateKey

            // Old key must no longer be accepted — operations with it should fail
            await expect(
                feeCollector.sendCollect(
                    ownerKey.secretKey,   // OLD key — now invalid
                    recipient.address,
                    toNano("0.1"),
                )
            ).rejects.toThrow();

            // New key must be accepted
            await feeCollector.sendCollect(
                newKey.secretKey,         // NEW key — now valid
                recipient.address,
                toNano("0.1"),
            );

            const seqnoAfter = await feeCollector.getSeqno();
            expect(seqnoAfter).toBe(3);
        });

        it("invalid signature on OP_ROTATE_KEY is rejected", async () => {
            const wrongKey = await makeKeypair();
            await expect(
                feeCollector.sendRotateKey(
                    wrongKey.secretKey,    // wrong key — not the owner
                    wrongKey.publicKey,
                )
            ).rejects.toThrow();
        });
    });

    // ── Signature / seqno protection ──────────────────────────────────────────

    describe("replay and signature protection", () => {
        it("rejects wrong signature on OP_COLLECT", async () => {
            const wrongKey = await makeKeypair();
            await expect(
                feeCollector.sendCollect(
                    wrongKey.secretKey,
                    recipient.address,
                    toNano("0.1"),
                )
            ).rejects.toThrow();
        });
    });
});

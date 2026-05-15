import {
    Address, beginCell, Cell, Contract, ContractProvider,
    contractAddress, Sender, SendMode, toNano,
} from "@ton/core";

// ── Op codes (must match utils/ops.tolk) ──────────────────────────────────────
export const Ops = {
    SUBSCRIBE:          0x4F520001,
    CANCEL:             0x4F520010,
    TOP_UP:             0x4F520011,
    PAUSE_SUB:          0x4F520012,
    RESUME_SUB:         0x4F520013,
    EMERGENCY_PAUSE:    0x4F520014,
    ROTATE_RELAYER:     0x4F520015,
    APPLY_PLAN:         0x4F520016,
    SET_MAX_PERIODS:    0x4F520017,
    CHARGE_EXT:         0x4F520030,
} as const;

// ── Status codes (must match core/subscription-state.tolk) ───────────────────
export const Status = {
    TRIAL:      1,
    ACTIVE:     2,
    PAUSED:     3,
    GRACE:      4,
    CANCELLED:  5,
} as const;

// ── Init data ─────────────────────────────────────────────────────────────────
export interface SubscriptionInitData {
    seqno:              number;
    status:             number;
    paymentType:        number;   // 1 = TON, 2 = JETTON
    keeperMode:         boolean;
    period:             number;   // seconds
    nextBillingTime:    number;   // unix timestamp
    planId:             number;
    maxPeriods:         number;   // 0 = unlimited
    periodsCharged:     number;
    amount:             bigint;
    deposit:            bigint;
    storageReserve:     bigint;
    feeBps:             number;   // basis points 0-1000
    trialPeriod:        number;   // 0 = no trial
    serviceAddr:        Address;
    subscriberAddr:     Address;
    factoryAddr:        Address;
    feeCollector:           Address;
    jettonWallet:           Address | null;
    relayerPubkey:          bigint;   // Ed25519 public key (256-bit); 0 only when keeperMode=true
    protocolFeeCollector:   Address;  // ORBIT protocol wallet — set from Factory.protocolFeeCollector
}

// ── Storage cell builder ─────────────────────────────────────────────────────
export function buildSubscriptionData(
    init: SubscriptionInitData,
    chargingInProgress = false,
): Cell {
    const zeroAddr = beginCell().storeUint(0, 2).endCell().beginParse();
    const jettonWalletSlice = init.jettonWallet
        ? beginCell().storeAddress(init.jettonWallet).endCell().beginParse()
        : zeroAddr;

    return beginCell()
        .storeUint(init.seqno,                        32)
        .storeUint(init.status,                        4)
        .storeUint(init.paymentType,                   2)
        .storeUint(chargingInProgress ? 1 : 0,         1)   // charging_in_progress
        .storeUint(0,                                  1)   // paused_global
        .storeUint(init.keeperMode ? 1 : 0,            1)   // keeper_mode
        .storeUint(0,                                  8)   // retry_count
        .storeUint(init.period,                       32)
        .storeUint(init.nextBillingTime,              32)
        .storeUint(0,                                 32)   // grace_end_time
        .storeUint(init.planId,                       32)
        .storeUint(init.maxPeriods,                   32)
        .storeUint(init.periodsCharged,               32)
        .storeCoins(init.amount)
        .storeCoins(init.deposit)
        .storeCoins(init.storageReserve)
        .storeUint(init.feeBps,                       16)
        .storeUint(init.trialPeriod,                  32)
        .storeRef(
            beginCell()
                .storeAddress(init.serviceAddr)
                .storeAddress(init.subscriberAddr)
                .storeAddress(init.factoryAddr)
            .endCell()
        )
        .storeRef(
            beginCell()
                .storeAddress(init.feeCollector)
                .storeSlice(jettonWalletSlice)
                .storeUint(init.relayerPubkey, 256)
            .endCell()
        )
        .storeRef(
            beginCell()
                .storeAddress(init.protocolFeeCollector)
            .endCell()
        )
    .endCell();
}

// ── Contract wrapper ──────────────────────────────────────────────────────────

export class Subscription implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Subscription(address);
    }

    static createFromConfig(init: SubscriptionInitData, code: Cell, workchain = 0) {
        const data      = buildSubscriptionData(init);
        const initState = { code, data };
        return new Subscription(contractAddress(workchain, initState), initState);
    }

    // ── Internal messages ─────────────────────────────────────────────────────

    // Deploy + fund in one message.  The SandboxContract provider auto-includes
    // StateInit on the first internal call, so this is the correct way to
    // activate a directly-constructed Subscription in tests.
    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            bounce:   false,
        });
    }

    async sendCancel(provider: ContractProvider, via: Sender) {
        await provider.internal(via, {
            value:    toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell().storeUint(Ops.CANCEL, 32).storeUint(0, 64).endCell(),
        });
    }

    async sendTopUp(provider: ContractProvider, via: Sender, topUpAmount: bigint) {
        await provider.internal(via, {
            value:    topUpAmount + toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell().storeUint(Ops.TOP_UP, 32).storeUint(0, 64).endCell(),
        });
    }

    async sendPause(provider: ContractProvider, via: Sender) {
        await provider.internal(via, {
            value:    toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell().storeUint(Ops.PAUSE_SUB, 32).storeUint(0, 64).endCell(),
        });
    }

    async sendResume(provider: ContractProvider, via: Sender) {
        await provider.internal(via, {
            value:    toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell().storeUint(Ops.RESUME_SUB, 32).storeUint(0, 64).endCell(),
        });
    }

    async sendEmergencyPause(provider: ContractProvider, via: Sender) {
        await provider.internal(via, {
            value:    toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell().storeUint(Ops.EMERGENCY_PAUSE, 32).storeUint(0, 64).endCell(),
        });
    }

    // Service owner converts an existing subscription to fixed-term (or back to unlimited).
    // maxPeriods = 0 means unlimited. Effective immediately.
    async sendSetMaxPeriods(
        provider:   ContractProvider,
        via:        Sender,
        maxPeriods: number,
    ) {
        await provider.internal(via, {
            value:    toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell()
                .storeUint(Ops.SET_MAX_PERIODS, 32)
                .storeUint(0, 64)
                .storeUint(maxPeriods, 32)
            .endCell(),
        });
    }

    async sendRotateRelayer(
        provider: ContractProvider,
        via: Sender,
        newPubkey: bigint,
    ) {
        await provider.internal(via, {
            value:    toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell()
                .storeUint(Ops.ROTATE_RELAYER, 32)
                .storeUint(0, 64)
                .storeUint(newPubkey, 256)
            .endCell(),
        });
    }

    // ── Getters ───────────────────────────────────────────────────────────────

    async getSubscriptionData(provider: ContractProvider) {
        const result = await provider.get("get_subscription_data", []);
        const items  = result.stack;
        return {
            status:          Number(items.readBigNumber()),
            planId:          Number(items.readBigNumber()),
            amount:          items.readBigNumber(),
            deposit:         items.readBigNumber(),
            nextBillingTime: Number(items.readBigNumber()),
            period:          Number(items.readBigNumber()),
            retryCount:      Number(items.readBigNumber()),
        };
    }

    async getStatus(provider: ContractProvider): Promise<number> {
        const r = await provider.get("get_status", []);
        return Number(r.stack.readBigNumber());
    }

    async getSeqno(provider: ContractProvider): Promise<number> {
        const r = await provider.get("get_seqno", []);
        return Number(r.stack.readBigNumber());
    }

    async getDeposit(provider: ContractProvider): Promise<bigint> {
        const r = await provider.get("get_deposit", []);
        return r.stack.readBigNumber();
    }

    async getNextBillingTime(provider: ContractProvider): Promise<number> {
        const r = await provider.get("get_next_billing_time", []);
        return Number(r.stack.readBigNumber());
    }

    async getIsPaused(provider: ContractProvider): Promise<boolean> {
        const r = await provider.get("is_paused", []);
        return Number(r.stack.readBigNumber()) === 1;
    }

    async getRelayerPubkey(provider: ContractProvider): Promise<bigint> {
        const r = await provider.get("get_relayer_pubkey", []);
        return r.stack.readBigNumber();
    }

    async getPeriodsCharged(provider: ContractProvider): Promise<number> {
        const r = await provider.get("get_periods_charged", []);
        return Number(r.stack.readBigNumber());
    }

    async getIsKeeperMode(provider: ContractProvider): Promise<boolean> {
        const r = await provider.get("is_keeper_mode", []);
        return Number(r.stack.readBigNumber()) === 1;
    }

    async getPaymentType(provider: ContractProvider): Promise<number> {
        const r = await provider.get("get_payment_type", []);
        return Number(r.stack.readBigNumber()); // 1 = TON, 2 = JETTON
    }

    async getVersion(provider: ContractProvider): Promise<number> {
        const r = await provider.get("get_version", []);
        return Number(r.stack.readBigNumber());
    }
}

import {
    Address, beginCell, Cell, Contract, ContractProvider,
    contractAddress, Dictionary, Sender, SendMode, toNano,
} from "@ton/core";

export const FactoryOps = {
    SUBSCRIBE:           0x4F520001,
    ADD_PLAN:            0x4F520002,
    DEACTIVATE_PLAN:     0x4F520003,
    FACTORY_PAUSE:       0x4F520004,
    FACTORY_RESUME:      0x4F520005,
    FACTORY_WITHDRAW:    0x4F520006,
    CHANGE_PLAN:         0x4F520007,
    CHARGE_NOTIFICATION: 0x4F520008,
    FUND_KEEPER_POOL:    0x4F520009,
    UPDATE_FEE_BPS:      0x4F52000A,
} as const;

export const PAYMENT_TON    = 1;
export const PAYMENT_JETTON = 2;

export interface PlanConfig {
    price:        bigint;
    period:       number;   // seconds
    trialPeriod:  number;   // 0 = no trial
    nameHash?:    bigint;   // sha256 of human-readable plan name; defaults to 0n
}

export interface FactoryConfig {
    relayerPubkey: bigint;  // Ed25519 public key stored in subscriptions
    serviceAddr:   Address;
    feeCollector:  Address;
    feeBps:        number;  // e.g. 20 = 0.2%
    subCode:       Cell;    // compiled Subscription contract code
    plans:         PlanConfig[];
}

function buildPlanCell(plan: PlanConfig): Cell {
    return beginCell()
        .storeCoins(plan.price)
        .storeUint(plan.period,            32)
        .storeUint(plan.trialPeriod,       32)
        .storeUint(1,                       1) // active = true
        .storeUint(plan.nameHash ?? 0n,   256)
    .endCell();
}

// Storage layout (matches factory.tolk):
//   Root bits: relayer_pubkey(256) seqno(32) paused(1) plan_count(32) fee_bps(16)
//              total_charges(64) total_revenue(coins) keeper_pool(coins)
//   Ref0: plans dict
//   Ref1: subscriber_info dict (empty at deploy)
//   Ref2: subscription_code
//   Ref3: service_addr + fee_collector
export function buildFactoryData(cfg: FactoryConfig): Cell {
    const plans = Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.Cell());
    cfg.plans.forEach((plan, idx) => plans.set(idx, buildPlanCell(plan)));

    return beginCell()
        .storeUint(cfg.relayerPubkey, 256)
        .storeUint(0,  32)   // seqno = 0
        .storeUint(0,   1)   // paused = false
        .storeUint(cfg.plans.length, 32)
        .storeUint(cfg.feeBps, 16)
        .storeUint(0,  64)   // total_charges = 0
        .storeCoins(0n)      // total_revenue = 0
        .storeCoins(0n)      // keeper_pool = 0
        .storeRef(beginCell().storeDictDirect(plans).endCell())
        .storeRef(beginCell().endCell())  // subscriber_info = empty dict
        .storeRef(cfg.subCode)
        .storeRef(
            beginCell()
                .storeAddress(cfg.serviceAddr)
                .storeAddress(cfg.feeCollector)
            .endCell()
        )
    .endCell();
}

export class Factory implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromConfig(cfg: FactoryConfig, code: Cell, workchain = 0) {
        const data = buildFactoryData(cfg);
        const initState = { code, data };
        return new Factory(contractAddress(workchain, initState), initState);
    }

    static createFromAddress(address: Address) {
        return new Factory(address);
    }

    // ── Deploy ───────────────────────────────────────────────────────────────

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell().endCell(),
        });
    }

    // ── Subscribe ─────────────────────────────────────────────────────────────
    //
    // For TON subscriptions, just pass planId and deposit.
    // For Jetton subscriptions, also pass paymentType=PAYMENT_JETTON and
    // subscriberJettonWallet (the subscriber's Jetton wallet address).

    async sendSubscribe(
        provider:               ContractProvider,
        via:                    Sender,
        planId:                 number,
        depositAmount:          bigint,
        paymentType:            number    = PAYMENT_TON,
        subscriberJettonWallet: Address | null = null,
    ) {
        let body = beginCell()
            .storeUint(FactoryOps.SUBSCRIBE, 32)
            .storeUint(0, 64)
            .storeUint(planId, 32)
            .storeUint(paymentType, 2);

        if (paymentType === PAYMENT_JETTON) {
            if (!subscriberJettonWallet) {
                throw new Error("subscriberJettonWallet required for Jetton subscriptions");
            }
            body = body.storeAddress(subscriberJettonWallet) as typeof body;
        }

        await provider.internal(via, {
            value:    depositAmount + toNano("0.2"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     body.endCell(),
        });
    }

    // ── Plan management ───────────────────────────────────────────────────────

    async sendAddPlan(provider: ContractProvider, via: Sender, plan: PlanConfig) {
        await provider.internal(via, {
            value:    toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell()
                .storeUint(FactoryOps.ADD_PLAN, 32)
                .storeUint(0, 64)
                .storeCoins(plan.price)
                .storeUint(plan.period,           32)
                .storeUint(plan.trialPeriod,      32)
                .storeUint(plan.nameHash ?? 0n,  256)
            .endCell(),
        });
    }

    async sendDeactivatePlan(provider: ContractProvider, via: Sender, planId: number) {
        await provider.internal(via, {
            value:    toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell()
                .storeUint(FactoryOps.DEACTIVATE_PLAN, 32)
                .storeUint(0, 64)
                .storeUint(planId, 32)
            .endCell(),
        });
    }

    // ── Change
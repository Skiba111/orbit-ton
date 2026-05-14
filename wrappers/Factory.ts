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

    // ── Change plan (subscriber requests via factory) ─────────────────────────
    //
    // The factory looks up the subscriber's sub_addr from subscriber_info dict.
    // The caller does NOT provide the subscription address — factory uses the
    // stored address to prevent OP_APPLY_PLAN spoofing.

    async sendChangePlan(
        provider:  ContractProvider,
        via:       Sender,
        newPlanId: number,
    ) {
        await provider.internal(via, {
            value:    toNano("0.1"),   // covers OP_APPLY_PLAN forward gas
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell()
                .storeUint(FactoryOps.CHANGE_PLAN, 32)
                .storeUint(0, 64)
                .storeUint(newPlanId, 32)
            .endCell(),
        });
    }

    // ── Keeper pool funding (no auth — anyone can contribute) ────────────────

    async sendFundKeeperPool(
        provider:     ContractProvider,
        via:          Sender,
        contribution: bigint,
    ) {
        await provider.internal(via, {
            value:    contribution + toNano("0.01"),  // contribution + gas
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell()
                .storeUint(FactoryOps.FUND_KEEPER_POOL, 32)
                .storeUint(0, 64)
            .endCell(),
        });
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    async sendPause(provider: ContractProvider, via: Sender) {
        await provider.internal(via, {
            value:    toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell().storeUint(FactoryOps.FACTORY_PAUSE, 32).storeUint(0, 64).endCell(),
        });
    }

    async sendResume(provider: ContractProvider, via: Sender) {
        await provider.internal(via, {
            value:    toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell().storeUint(FactoryOps.FACTORY_RESUME, 32).storeUint(0, 64).endCell(),
        });
    }

    async sendWithdraw(provider: ContractProvider, via: Sender) {
        await provider.internal(via, {
            value:    toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell().storeUint(FactoryOps.FACTORY_WITHDRAW, 32).storeUint(0, 64).endCell(),
        });
    }

    // ── Getters ───────────────────────────────────────────────────────────────

    async getPlanCount(provider: ContractProvider): Promise<number> {
        const result = await provider.get("get_plan_count", []);
        return Number(result.stack.readBigNumber());
    }

    async getPlanData(provider: ContractProvider, planId: number) {
        const result = await provider.get("get_plan_data", [
            { type: "int", value: BigInt(planId) },
        ]);
        const stack = result.stack;
        return {
            price:       stack.readBigNumber(),
            period:      Number(stack.readBigNumber()),
            trialPeriod: Number(stack.readBigNumber()),
            active:      Number(stack.readBigNumber()) === 1,
            nameHash:    stack.readBigNumber(),
        };
    }

    async isFactoryPaused(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get("is_factory_paused", []);
        return Number(result.stack.readBigNumber()) === 1;
    }

    async getSubscriptionCode(provider: ContractProvider): Promise<Cell> {
        const result = await provider.get("get_subscription_code", []);
        return result.stack.readCell();
    }

    async getRelayerPubkey(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get("get_relayer_pubkey", []);
        return result.stack.readBigNumber();
    }

    async getTotalCharges(provider: ContractProvider): Promise<number> {
        const result = await provider.get("get_total_charges", []);
        return Number(result.stack.readBigNumber());
    }

    async getTotalRevenue(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get("get_total_revenue", []);
        return result.stack.readBigNumber();
    }

    async getKeeperPool(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get("get_keeper_pool", []);
        return result.stack.readBigNumber();
    }

    async getFeeBps(provider: ContractProvider): Promise<number> {
        const result = await provider.get("get_fee_bps", []);
        return Number(result.stack.readBigNumber());
    }

    async getVersion(provider: ContractProvider): Promise<number> {
        const result = await provider.get("get_version", []);
        return Number(result.stack.readBigNumber());
    }

    // Updates protocol fee for NEW subscriptions only; existing subs are unaffected.
    async sendUpdateFeeBps(provider: ContractProvider, via: Sender, feeBps: number) {
        await provider.internal(via, {
            value:    toNano("0.05"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell()
                .storeUint(FactoryOps.UPDATE_FEE_BPS, 32)
                .storeUint(0, 64)
                .storeUint(feeBps, 16)
            .endCell(),
        });
    }

    // Returns the subscription address for a given subscriber + plan combination.
    // Returns the stored address if the subscriber has ever subscribed through this factory,
    // or computes the deterministic address for new subscribers.
    //
    // paymentType: 0 = TON (default), 1 = JETTON.
    // subscriberJettonWallet: required when paymentType = JETTON; null otherwise.
    // IMPORTANT: paymentType must match what the subscriber will use in OP_SUBSCRIBE —
    // it is baked into the contract address and wrong value returns the wrong address.
    async getSubscriptionAddress(
        provider:               ContractProvider,
        subscriberAddr:         Address,
        planId:                 number,
        paymentType:            0 | 1 = 0,
        subscriberJettonWallet: Address | null = null,
    ): Promise<Address> {
        const jettonWalletCell = subscriberJettonWallet
            ? beginCell().storeAddress(subscriberJettonWallet).endCell()
            : beginCell().storeUint(0, 2).endCell();  // addr_none for TON subscriptions

        const result = await provider.get("get_subscription_address", [
            { type: "slice", cell: beginCell().storeAddress(subscriberAddr).endCell() },
            { type: "int",   value: BigInt(planId) },
            { type: "int",   value: BigInt(paymentType) },
            { type: "slice", cell: jettonWalletCell },
        ]);
        return result.stack.readAddress();
    }
}

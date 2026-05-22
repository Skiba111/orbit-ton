// ORBIT React SDK — hooks.

import { useEffect, useState, useCallback, useContext, createContext } from "react";
import { TonClient, Address, toNano, beginCell }                       from "@ton/core";
import { useTonConnectUI }                                               from "@tonconnect/ui-react";
import { Subscription, Ops }                                             from "../../../wrappers/Subscription";
import { Factory }                                                       from "../../../wrappers/Factory";
import type { SubscriptionData, PlanData, OrbitConfig }                 from "./types";

export const PAYMENT_TON    = 1 as const;
export const PAYMENT_JETTON = 2 as const;
export type  PaymentType    = typeof PAYMENT_TON | typeof PAYMENT_JETTON;

// ── Context ───────────────────────────────────────────────────────────────────

const OrbitContext = createContext<{ config: OrbitConfig; client: TonClient } | null>(null);

export { OrbitContext };

function useOrbit() {
    const ctx = useContext(OrbitContext);
    if (!ctx) throw new Error("useOrbit: wrap your app in <OrbitProvider>");
    return ctx;
}

// ── useSubscription ───────────────────────────────────────────────────────────
//
// Reads the on-chain state of a Subscription contract and refreshes every
// `refreshInterval` ms (default 15 s).

export function useSubscription(
    subscriptionAddress: string | null,
    refreshInterval = 15_000,
) {
    const { client }              = useOrbit();
    const [data, setData]         = useState<SubscriptionData | null>(null);
    const [loading, setLoading]   = useState(false);
    const [error, setError]       = useState<string | null>(null);

    const fetch = useCallback(async () => {
        if (!subscriptionAddress) return;
        setLoading(true);
        setError(null);
        try {
            const addr = Address.parse(subscriptionAddress);
            const sub  = client.open(Subscription.createFromAddress(addr));
            const raw  = await sub.getSubscriptionData(client.provider(addr));
            setData(raw);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }, [subscriptionAddress, client]);

    useEffect(() => {
        fetch();
        const id = setInterval(fetch, refreshInterval);
        return () => clearInterval(id);
    }, [fetch, refreshInterval]);

    return { data, loading, error, refetch: fetch };
}

// ── useSubscribe ──────────────────────────────────────────────────────────────
//
// Returns a `subscribe(planId, depositAmount, paymentType?)` function that
// sends an OP_SUBSCRIBE message to the Factory via TonConnect.
//
// paymentType defaults to PAYMENT_TON (1).  Pass PAYMENT_JETTON (2) for Jetton
// subscriptions; in that case the subscriber must also have a Jetton wallet
// address ready to pass as `jettonWalletAddress`.

export function useSubscribe() {
    const { config, client }    = useOrbit();
    const [tonConnectUI]        = useTonConnectUI();
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState<string | null>(null);

    const subscribe = useCallback(async (
        planId:              number,
        depositAmount:       bigint,
        paymentType:         PaymentType  = PAYMENT_TON,
        jettonWalletAddress: string | null = null,
    ) => {
        setLoading(true);
        setError(null);
        try {
            const factoryAddr = Address.parse(config.factoryAddress);
            const factory     = client.open(Factory.createFromAddress(factoryAddr));

            const planData = await factory.getPlanData(client.provider(factoryAddr), planId);
            // For TON subscriptions the value must cover at least one billing cycle + gas.
            // For Jetton subscriptions the TON value is gas only — the actual deposit is
            // in Jetton tokens transferred separately; sending planData.price in TON would
            // be incorrect and would lock the subscriber's TON unnecessarily.
            const minValue = paymentType === PAYMENT_JETTON
                ? toNano("0.2")                        // gas budget for Jetton flow
                : planData.price + toNano("0.1");      // 1 cycle + gas for TON flow
            const value = depositAmount > minValue ? depositAmount : minValue;

            const body = buildSubscribeCell(planId, paymentType, jettonWalletAddress);

            await tonConnectUI.sendTransaction({
                messages: [{
                    address: config.factoryAddress,
                    amount:  value.toString(),
                    payload: body.toBoc().toString("base64"),
                }],
            });
        } catch (e) {
            setError((e as Error).message);
            throw e;
        } finally {
            setLoading(false);
        }
    }, [config, client, tonConnectUI]);

    return { subscribe, loading, error };
}

// ── useFactory ────────────────────────────────────────────────────────────────

export function useFactory() {
    const { config, client }     = useOrbit();
    const [plans, setPlans]      = useState<PlanData[]>([]);
    const [loading, setLoading]  = useState(false);
    const [error, setError]      = useState<string | null>(null);
    const [totalRevenue, setRev] = useState<bigint>(0n);
    const [totalCharges, setChg] = useState<number>(0);
    const [keeperPool, setPool]  = useState<bigint>(0n);

    const fetchFactory = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const factoryAddr = Address.parse(config.factoryAddress);
            const factory     = client.open(Factory.createFromAddress(factoryAddr));
            const provider    = client.provider(factoryAddr);

            const count = await factory.getPlanCount(provider);
            const loaded: PlanData[] = [];
            for (let i = 0; i < count; i++) {
                const d = await factory.getPlanData(provider, i);
                loaded.push({ planId: i, ...d });
            }
            setPlans(loaded);
            setRev(await factory.getTotalRevenue(provider));
            setChg(await factory.getTotalCharges(provider));
            setPool(await factory.getKeeperPool(provider));
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }, [config, client]);

    useEffect(() => { fetchFactory(); }, [fetchFactory]);

    return { plans, totalRevenue, totalCharges, keeperPool, loading, error, refetch: fetchFactory };
}

// ── useCancel ─────────────────────────────────────────────────────────────────
//
// Sends OP_CANCEL (0x4F520010) to the subscriber's Subscription contract.
// After confirmation the contract moves to CANCELLED state and refunds the
// remaining deposit minus a small reserve.

export function useCancel() {
    const [tonConnectUI]        = useTonConnectUI();
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState<string | null>(null);

    const cancel = useCallback(async (subscriptionAddress: string) => {
        setLoading(true);
        setError(null);
        try {
            const body = beginCell()
                .storeUint(Ops.CANCEL, 32)
                .storeUint(0, 64)
            .endCell();

            await tonConnectUI.sendTransaction({
                messages: [{
                    address: subscriptionAddress,
                    amount:  toNano("0.05").toString(),
                    payload: body.toBoc().toString("base64"),
                }],
            });
        } catch (e) {
            setError((e as Error).message);
            throw e;
        } finally {
            setLoading(false);
        }
    }, [tonConnectUI]);

    return { cancel, loading, error };
}

// ── useTopUp ──────────────────────────────────────────────────────────────────
//
// Sends OP_TOP_UP (0x4F520011) to top up the subscriber's deposit.
// The `topUpAmount` is in nanoton and will be added to the contract's deposit.

export function useTopUp() {
    const [tonConnectUI]        = useTonConnectUI();
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState<string | null>(null);

    const topUp = useCallback(async (subscriptionAddress: string, topUpAmount: bigint) => {
        setLoading(true);
        setError(null);
        try {
            const body = beginCell()
                .storeUint(Ops.TOP_UP, 32)
                .storeUint(0, 64)
            .endCell();

            await tonConnectUI.sendTransaction({
                messages: [{
                    address: subscriptionAddress,
                    // topUpAmount goes into deposit; +0.05 TON for gas
                    amount:  (topUpAmount + toNano("0.05")).toString(),
                    payload: body.toBoc().toString("base64"),
                }],
            });
        } catch (e) {
            setError((e as Error).message);
            throw e;
        } finally {
            setLoading(false);
        }
    }, [tonConnectUI]);

    return { topUp, loading, error };
}

// ── usePause / useResume ──────────────────────────────────────────────────────
//
// Subscriber-initiated pause (OP_PAUSE_SUB) and resume (OP_RESUME_SUB).
// A paused subscription stops auto-charges but keeps the deposit locked.

export function usePause() {
    const [tonConnectUI]        = useTonConnectUI();
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState<string | null>(null);

    const pause = useCallback(async (subscriptionAddress: string) => {
        setLoading(true);
        setError(null);
        try {
            const body = beginCell()
                .storeUint(Ops.PAUSE_SUB, 32)
                .storeUint(0, 64)
            .endCell();
            await tonConnectUI.sendTransaction({
                messages: [{
                    address: subscriptionAddress,
                    amount:  toNano("0.05").toString(),
                    payload: body.toBoc().toString("base64"),
                }],
            });
        } catch (e) {
            setError((e as Error).message);
            throw e;
        } finally {
            setLoading(false);
        }
    }, [tonConnectUI]);

    return { pause, loading, error };
}

export function useResume() {
    const [tonConnectUI]        = useTonConnectUI();
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState<string | null>(null);

    const resume = useCallback(async (subscriptionAddress: string) => {
        setLoading(true);
        setError(null);
        try {
            const body = beginCell()
                .storeUint(Ops.RESUME_SUB, 32)
                .storeUint(0, 64)
            .endCell();
            await tonConnectUI.sendTransaction({
                messages: [{
                    address: subscriptionAddress,
                    amount:  toNano("0.05").toString(),
                    payload: body.toBoc().toString("base64"),
                }],
            });
        } catch (e) {
            setError((e as Error).message);
            throw e;
        } finally {
            setLoading(false);
        }
    }, [tonConnectUI]);

    return { resume, loading, error };
}

// ── useChangePlan ─────────────────────────────────────────────────────────────
//
// Sends OP_CHANGE_PLAN to the Factory. The Factory looks up the subscriber's
// existing Subscription address and forwards OP_APPLY_PLAN internally —
// the subscriber does NOT need to know their subscription address.

export function useChangePlan() {
    const { config, client }    = useOrbit();
    const [tonConnectUI]        = useTonConnectUI();
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState<string | null>(null);

    const changePlan = useCallback(async (newPlanId: number) => {
        setLoading(true);
        setError(null);
        try {
            const body = beginCell()
                .storeUint(0x4F520007, 32)  // OP_CHANGE_PLAN
                .storeUint(0, 64)
                .storeUint(newPlanId, 32)
            .endCell();

            await tonConnectUI.sendTransaction({
                messages: [{
                    address: config.factoryAddress,
                    amount:  toNano("0.1").toString(), // gas budget for forward message
                    payload: body.toBoc().toString("base64"),
                }],
            });
        } catch (e) {
            setError((e as Error).message);
            throw e;
        } finally {
            setLoading(false);
        }
    }, [config, tonConnectUI]);

    return { changePlan, loading, error };
}

// ── Cell builder ──────────────────────────────────────────────────────────────
//
// Builds OP_SUBSCRIBE body using @ton/core Cell API so bit-packing is exact.
// The contract reads: op(32) query_id(64) plan_id(32) payment_type(2) [jetton_wallet?]
//
// Using raw Buffer was incorrect because it cannot represent sub-byte fields —
// the 2-bit payment_type would be misaligned without Cell's bit-level packing.

export function buildSubscribeCell(
    planId:              number,
    paymentType:         PaymentType  = PAYMENT_TON,
    jettonWalletAddress: string | null = null,
) {
    let builder = beginCell()
        .storeUint(0x4F520001, 32)  // OP_SUBSCRIBE
        .storeUint(0, 64)           // query_id = 0
        .storeUint(planId, 32)
        .storeUint(paymentType, 2); // PAYMENT_TON=1 or PAYMENT_JETTON=2

    if (paymentType === PAYMENT_JETTON) {
        if (!jettonWalletAddress) {
            throw new Error("jettonWalletAddress is required for Jetton subscriptions");
        }
        builder = builder.storeAddress(Address.parse(jettonWalletAddress)) as typeof builder;
    }

    return builder.endCell();
}

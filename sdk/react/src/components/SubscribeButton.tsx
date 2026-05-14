// ORBIT React SDK — SubscribeButton component.
//
// Renders a "Subscribe" button that opens a TonConnect transaction.
// Disables itself during loading and shows an error tooltip on failure.

import React, { useState }                       from "react";
import { toNano }                                from "@ton/core";
import { useSubscribe, PAYMENT_TON, PaymentType } from "../hooks";
import type { PlanData }                          from "../types";

interface Props {
    plan:                 PlanData;
    depositPeriods?:      number;          // how many periods to pre-fund (default 1)
    paymentType?:         PaymentType;     // PAYMENT_TON (default) or PAYMENT_JETTON
    jettonWalletAddress?: string;          // required when paymentType = PAYMENT_JETTON
    label?:               string;
    className?:           string;
    onSuccess?:           () => void;
    onError?:             (err: Error) => void;
}

export function SubscribeButton({
    plan,
    depositPeriods = 1,
    paymentType    = PAYMENT_TON,
    jettonWalletAddress,
    label          = "Subscribe",
    className,
    onSuccess,
    onError,
}: Props) {
    const { subscribe, loading } = useSubscribe();
    const [err, setErr]          = useState<string | null>(null);

    async function handleClick() {
        setErr(null);
        try {
            const deposit = plan.price * BigInt(depositPeriods);
            await subscribe(plan.planId, deposit, paymentType, jettonWalletAddress ?? null);
            onSuccess?.();
        } catch (e) {
            const msg = (e as Error).message;
            setErr(msg);
            onError?.(e as Error);
        }
    }

    return (
        <div style={{ display: "inline-block" }}>
            <button
                className={className}
                onClick={handleClick}
                disabled={loading || !plan.active}
                style={{
                    cursor:  loading || !plan.active ? "not-allowed" : "pointer",
                    opacity: loading || !plan.active
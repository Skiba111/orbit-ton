// ORBIT React SDK — TopUpDeposit component.
//
// A simple form that lets a subscriber top-up their subscription deposit.
// Sends OP_TOP_UP via TonConnect.

import React, { useState, useCallback } from "react";
import { toNano, beginCell }             from "@ton/core";
import { useTonConnectUI }               from "@tonconnect/ui-react";

interface Props {
    subscriptionAddress: string;
    className?:          string;
    onSuccess?:          () => void;
}

export function TopUpDeposit({ subscriptionAddress, className, onSuccess }: Props) {
    const [tonConnectUI]     = useTonConnectUI();
    const [amountStr, setAmt] = useState("1");
    const [loading, setLoad]  = useState(false);
    const [error, setErr]     = useState<string | null>(null);

    const handleTopUp = useCallback(async () => {
        const ton = parseFloat(amountStr);
        if (isNaN(ton) || ton <= 0) {
            setErr("Enter a positive amount");
            return;
        }
        setLoad(true);
        setErr(null);
        try {
            const depositNano = toNano(amountStr.trim());
            const gasNano     = toNano("0.05");
            const total       = depositNano + gasNano;

            const body = beginCell()
                .storeUint(0x4F520011, 32)  // OP_TOP_UP
                .storeUint(0, 64)           // query_id
            .endCell();

            await tonConnectUI.sendTransaction({
                messages: [{
                    address: subscriptionAddress,
                    amount:  total.toString(),
                    payload: body.toBoc().toString("base64"),
                }],
            });
            onSuccess?.();
        } catch (e) {
            setErr((e as Error).message);
        } finally {
            setLoad(false);
        }
    }, [subscriptionAddress, amountStr, tonConnectUI, onSuccess]);

    return (
        <div className={className} style={{ fontFamily: "sans-serif" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={amountStr}
                    onChange={(e) => setAmt(e.target.value)}
                    placeholder="Amount (TON)"
                    style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #ccc", width: 140 }}
                />
                <button
                    onClick={handleTopUp}
                    disabled={loading}
                    style={{
                        background: "#6c63ff", color: "#fff",
                        border: "none", borderRadius: 6, padding: "6px 16px",
                        cursor: loading ? "not-allowed" : "pointer",
                        opacity: loading ? 0.6 : 1,
                    }}
                >
                    {loading ? "Sending…" : "Top up"}
                </button>
            </div>
            {error && <p style={{ color: "red", fontSize: "0.8em", marginTop: 4 }}>{error}</p>}
        </div>
    );
}

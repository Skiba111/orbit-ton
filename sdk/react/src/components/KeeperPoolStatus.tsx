// ORBIT React SDK — KeeperPoolStatus component.
//
// Shows the current keeper pool balance and lets anyone top it up.
// Services fund this pool so keepers always have a bonus on top of the base
// reward paid from each subscription's own balance.

import React, { useContext, useState }  from "react";
import { toNano, beginCell }            from "@ton/core";
import { useTonConnectUI }              from "@tonconnect/ui-react";
import { useFactory, OrbitContext }     from "../hooks";

interface Props {
    /** Minimum top-up amount in TON (default 1). */
    minTopUp?:  number;
    className?: string;
    onFunded?:  () => void;
}

function nanoTonToTon(nano: bigint): string {
    return (Number(nano) / 1e9).toFixed(3);
}

export function KeeperPoolStatus({ minTopUp = 1, className, onFunded }: Props) {
    const ctx             = useContext(OrbitContext);
    const { keeperPool, loading, error, refetch } = useFactory();
    const [tonConnectUI]  = useTonConnectUI();
    const [amount, setAmount]   = useState(String(minTopUp));
    const [funding, setFunding] = useState(false);
    const [fundError, setFundError] = useState<string | null>(null);

    if (!ctx) return null;

    async function handleFund() {
        const tonAmount = parseFloat(amount);
        if (isNaN(tonAmount) || tonAmount < 0.006) {
            setFundError("Minimum is 0.006 TON (covers gas floor)");
            return;
        }
        setFunding(true);
        setFundError(null);
        try {
            // value = contribution + 0.005 TON handling floor (contract requires > 5000000)
            const value = toNano(tonAmount.toFixed(9)) + toNano("0.005");

            const body = beginCell()
                .storeUint(0x4F520009, 32)  // OP_FUND_KEEPER_POOL
                .storeUint(0, 64)           // query_id
            .endCell();

            await tonConnectUI.sendTransaction({
                messages: [{
                    address: ctx.config.factoryAddress,
                    amount:  value.toString(),
                    payload: body.toBoc().toString("base64"),
                }],
            });
            await refetch();
            onFunded?.();
        } catch (e) {
            setFundError((e as Error).message);
        } finally {
            setFunding(false);
        }
    }

    if (loading && keeperPool === 0n) {
        return <div className={className}>Loading…</div>;
    }

    const poolTon = nanoTonToTon(keeperPool);
    const isLow   = keeperPool < toNano("0.1");

    return (
        <div className={className} style={{ fontFamily: "sans-serif", padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Keeper Pool</span>
                <span style={{
                    background: isLow ? "#f59e0b" : "#22c55e",
                    color:      "#fff",
                    borderRadius: 10,
                    padding:    "1px 8px",
                    fontSize:   "0.8em",
                }}>
                    {isLow ? "Low" : "Funded"}
                </span>
            </div>

            <p style={{ margin: "0 0 12px", color: "#555" }}>
                {poolTon} TON available for keeper bonuses
            </p>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                    type="number"
                    min={minTopUp}
                    step="0.1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    style={{
                        width: 80, padding: "4px 8px",
                        border: "1px solid #ddd", borderRadius: 4,
                    }}
                />
                <span style={{ color: "#888", fontSize: "0.9em" }}>TON</span>
                <button
                    onClick={handleFund}
                    disabled={funding}
                    style={{
                        background: "#6c63ff", color: "#fff",
                        border:     "none", borderRadius: 6,
                        padding:    "5px 14px",
                        cursor:     funding ? "not-allowed" : "pointer",
                        opacity:    funding ? 0.7 : 1,
                    }}
                >
                    {funding ? "Sending…" : "Top up"}
                </button>
            </div>

            {(error || fundError) && (
                <p style={{ color: "#ef4444", fontSize: "0.8em", marginTop: 6 }}>
                    {fundError ?? error}
                </p>
            )}
        </div>
    );
}

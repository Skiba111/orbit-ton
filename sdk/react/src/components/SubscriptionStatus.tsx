// ORBIT React SDK — SubscriptionStatus component.
//
// Displays the current state of a subscription: status label, next billing
// time countdown, deposit balance, and a Cancel button.

import React, { useCallback }      from "react";
import { toNano, beginCell }        from "@ton/core";
import { useTonConnectUI }          from "@tonconnect/ui-react";
import { useSubscription }          from "../hooks";
import { SubscriptionStatus as S }  from "../types";

interface Props {
    subscriptionAddress: string;
    className?:          string;
    onCancelled?:        () => void;
}

const STATUS_LABELS: Record<number, string> = {
    [S.TRIAL]:     "Trial",
    [S.ACTIVE]:    "Active",
    [S.PAUSED]:    "Paused",
    [S.GRACE]:     "Grace period",
    [S.CANCELLED]: "Cancelled",
};

const STATUS_COLORS: Record<number, string> = {
    [S.TRIAL]:     "#6c63ff",
    [S.ACTIVE]:    "#22c55e",
    [S.PAUSED]:    "#f59e0b",
    [S.GRACE]:     "#ef4444",
    [S.CANCELLED]: "#6b7280",
};

function nanoTonToTon(nano: bigint): string {
    return (Number(nano) / 1e9).toFixed(4);
}

function formatCountdown(unixTs: number): string {
    const diff = unixTs - Math.floor(Date.now() / 1000);
    if (diff <= 0) return "Due now";
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    const m = Math.floor((diff % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

// Build OP_CANCEL body using Cell so bit-packing is exact (no raw Buffer).
function buildCancelCell() {
    return beginCell()
        .storeUint(0x4F520010, 32)  // OP_CANCEL
        .storeUint(0, 64)           // query_id
    .endCell();
}

export function SubscriptionStatus({ subscriptionAddress, className, onCancelled }: Props) {
    const { data, loading, error } = useSubscription(subscriptionAddress);
    const [tonConnectUI]           = useTonConnectUI();

    const handleCancel = useCallback(async () => {
        await tonConnectUI.sendTransaction({
            messages: [{
                address: subscriptionAddress,
                amount:  toNano("0.05").toString(),
                payload: buildCancelCell().toBoc().toString("base64"),
            }],
        });
        onCancelled?.();
    }, [subscriptionAddress, tonConnectUI, onCancelled]);

    if (loading && !data) return <div className={className}>Loading…</div>;
    if (error)            return <div className={className} style={{ color: "red" }}>{error}</div>;
    if (!data)            return null;

    const statusLabel = STATUS_LABELS[data.status] ?? "Unknown";
    const statusColor = STATUS_COLORS[data.status] ?? "#6b7280";

    return (
        <div className={className} style={{ fontFamily: "sans-serif", padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <span style={{
                    background: statusColor, color: "#fff",
                    borderRadius: 12, padding: "2px 10px", fontSize: "0.85em",
                }}>
                    {statusLabel}
                </span>
            </div>

            <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <tbody>
                    <tr>
                        <td style={{ color: "#888", paddingRight: 16 }}>Next billing</td>
                        <td>{data.nextBillingTime ? formatCountdown(data.nextBillingTime) : "—"}</td>
                    </tr>
                    <tr>
                        <td style={{ color: "#888" }}>Deposit</td>
                        <td>{nanoTonToTon(data.deposit)} TON</td>
                    </tr>
                    <tr>
                        <td style={{ color: "#888" }}>Amount / cycle</td>
                        <td>{nanoTonToTon(data.amount)} TON</td>
                    </tr>
                    <tr>
                        <td style={{ color: "#888" }}>Retry count</td>
                        <td>{data.retryCount}</td>
                    </tr>
                </tbody>
            </table>

            {data.status !== S.CANCELLED && (
                <button
                    onClick={handleCancel}
                    style={{
                        marginTop: 16, background: "#ef4444", color: "#fff",
                        border: "none", borderRadius: 6, padding: "6px 16px", cursor: "pointer",
                    }}
                >
                    Cancel subscription
                </button>
            )}
        </div>
    );
}

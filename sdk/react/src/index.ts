// ORBIT React SDK — public API.

export { OrbitContext }                                   from "./hooks";
export { useSubscription, useSubscribe, useFactory }      from "./hooks";
export { buildSubscribeCell, PAYMENT_TON, PAYMENT_JETTON } from "./hooks";
export type { PaymentType }                               from "./hooks";

export { SubscribeButton }     from "./components/SubscribeButton";
export { SubscriptionStatus }  from "./components/SubscriptionStatus";
export { TopUpDeposit }        from "./components/TopUpDeposit";
export { KeeperPoolStatus }    from "./components/KeeperPoolStatus";

export type { SubscriptionData, PlanData, OrbitConfig, StatusCode } from "./types";
export { SubscriptionStatus as SubscriptionStatusCodes }             from "./types";

// ── OrbitProvider ─────────────────────────────────────────────────────────────
//
// Wrap your app with <OrbitProvider config={...}> so all ORBIT hooks can
// reach the TonClient without prop-drilling.
//
// Example:
//   <OrbitProvider config={{ factoryAddress: "EQ...", endpoint: "https://..." }}>
//     <App />
//   </OrbitProvider>

import React, { useMemo }   from "react";
import { TonClient }        from "@ton/core";
import type { OrbitConfig } from "./types";
import { OrbitContext }     from "./hooks";

interface ProviderProps {
    config:   OrbitConfig;
    children: React.ReactNode;
}

export function OrbitProvider({ config, children }: ProviderProps) {
    const client = useMemo(
        () => new TonClient({ endpoint: config.endpoint, apiKey: config.apiKey }),
        [config.endpoint, config.apiKey],
    );
    return (
        <OrbitContext.Provider value={{ config, client }}>
            {children}
        </OrbitContext.Provider>
    );
}

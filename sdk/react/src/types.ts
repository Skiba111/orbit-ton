// ORBIT React SDK — shared TypeScript types.

export interface SubscriptionData {
    status:          number;
    planId:          number;
    amount:          bigint;
    deposit:         bigint;
    nextBillingTime: number;
    period:          number;
    retryCount:      number;
}

export interface PlanData {
    planId:      number;
    price:       bigint;
    period:      number;
    trialPeriod: number;
    active:      boolean;
    nameHash:    bigint;
}

export const SubscriptionStatus = {
    TRIAL:     1,
    ACTIVE:    2,
    PAUSED:    3,
    GRACE:     4,
    CANCELLED: 5,
} as const;

export type StatusCode = typeof SubscriptionStatus[keyof typeof SubscriptionStatus];

export interface OrbitConfig {
    /** Address of the deployed Factory contract */
    factoryAddress: string;
    /** TON endpoint URL */
    endpoint:       string;
    /** Optional TonCenter API key */
    apiKey?:        string;
}

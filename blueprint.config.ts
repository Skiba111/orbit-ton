import { Config } from "@ton/blueprint";

export const config: Config = {
    network: {
        endpoint: "https://toncenter.com/api/v2/jsonRPC",
        type: "toncenter-v2",
        version: "v2",
        key: process.env.TONCENTER_API_KEY,
    },
};

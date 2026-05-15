import { Cell } from "@ton/core";
import { compileTolk } from "../tests/helpers/compileTolk";

let cache: Cell | null = null;

export async function compile(): Promise<Cell> {
    if (!cache) cache = await compileTolk("factory");
    return cache;
}

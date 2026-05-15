import { Cell }               from "@ton/core";
import { runTolkCompiler }    from "@ton/tolk-js";
import * as fs                from "fs";
import * as path              from "path";

const ROOT = path.resolve(__dirname, "../..").replace(/\\/g, "/");

// The Tolk WASM compiler runs in a Linux emulation layer on Windows.
// It strips the drive letter from paths it passes back to fsReadCallback,
// turning "C:/Users/..." into "/Users/...".  Re-attach the drive letter.
const DRIVE = ROOT.match(/^([A-Za-z]:)/)?.[1] ?? "";
function fixPath(p: string): string {
    if (DRIVE && p.startsWith("/") && !p.startsWith("//")) {
        return DRIVE + p;
    }
    return p;
}

// Cache compiled cells so tests that share beforeAll blocks don't re-compile.
const cache = new Map<string, Cell>();

export async function compileTolk(contractName: string): Promise<Cell> {
    if (cache.has(contractName)) return cache.get(contractName)!;

    const entrypoint = path.join(ROOT, "contracts", `${contractName}.tolk`).replace(/\\/g, "/");

    const result = await runTolkCompiler({
        entrypointFileName: entrypoint,
        fsReadCallback: (filePath: string) => fs.readFileSync(fixPath(filePath), "utf8"),
        optimizationLevel: 2,
    });

    if (result.status === "error") {
        throw new Error(`Tolk compilation failed for '${contractName}': ${result.message}`);
    }

    const cell = Cell.fromBase64(result.codeBoc64);
    cache.set(contractName, cell);
    return cell;
}

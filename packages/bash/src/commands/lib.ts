import { DefenseInDepthBox } from "../security/defense-in-depth-box.js";
import type { Command, CommandContext, ExecResult } from "../types.js";

// Replaced with `true` by esbuild for browser bundles. Using it as a
// build-time guard (rather than a runtime `globalThis.__BROWSER__` check)
// lets esbuild fold `if (__BROWSER__ ...)` and drop the dynamic
// `import("./flag-coverage.js")` below. That dynamic import statically pulls
// in the fuzz-flags aggregator, which in turn imports every command's flag
// metadata — including the node-only tar/yq/xan/sqlite3 modules. Because
// build:browser does not use code-splitting, esbuild inlines reachable dynamic
// imports into the main bundle, so without this guard those heavy/native
// command modules leak into browser.js.
declare const __BROWSER__: boolean | undefined;

export type CommandLoader = () => Promise<Command>;

export interface LazyCommandDef<T extends string = string> {
  name: T;
  load: CommandLoader;
}

const cache = new Map<string, Command>();

/**
 * Creates a lazy command that loads on first execution
 */
export function createLazyCommand(def: LazyCommandDef): Command {
  return {
    name: def.name,
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      let cmd = cache.get(def.name);

      if (!cmd) {
        // Lazy imports run inside the defense-in-depth context.
        cmd = await DefenseInDepthBox.runTrustedAsync(() => def.load());
        cache.set(def.name, cmd);
      }

      // Emit flag coverage hits when fuzzing. The flag-coverage module is
      // node-only (it pulls in the fuzz-flags aggregator and every command's
      // metadata), so this whole block is gated behind a build-time __BROWSER__
      // guard that esbuild folds to `if (false)` for browser bundles, dropping
      // the dynamic import and its node-only transitive deps. The leading
      // `typeof === "undefined"` keeps it safe in Node/vitest where __BROWSER__
      // is never defined.
      if (
        (typeof __BROWSER__ === "undefined" || !__BROWSER__) &&
        ctx.coverage
      ) {
        try {
          const { emitFlagCoverage } = await import("./flag-coverage.js");
          emitFlagCoverage(ctx.coverage, def.name, args);
        } catch (_e) {
          // Ignore coverage errors
        }
      }

      return DefenseInDepthBox.runTrustedAsync(() => cmd?.execute(args, ctx));
    },
  };
}

export function clearCommandCache(): void {
  cache.clear();
}

export function getLoadedCommandCount(): number {
  return cache.size;
}

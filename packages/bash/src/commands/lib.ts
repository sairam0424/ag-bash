import { DefenseInDepthBox } from "../security/defense-in-depth-box.js";
import type { Command, CommandContext, ExecResult } from "../types.js";

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

      // Emit flag coverage hits when fuzzing (not available in browser bundles)
      // Check if we are in browser environment locally to avoid import errors
      const isBrowser =
        typeof (globalThis as any).__BROWSER__ !== "undefined" &&
        (globalThis as any).__BROWSER__;

      if (ctx.coverage && !isBrowser) {
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

import type { LazyCommandDef } from "../lib.js";
import type {
  JavaScriptCommandName,
  NetworkCommandName,
  PythonCommandName,
} from "../registry.js";

// __BROWSER__ is defined by esbuild at build time for browser bundles.
// The guard is written inline (not via an intermediate `isBrowser` const) so
// esbuild folds it to `if (false)` and tree-shakes the node-only runtime
// loaders out of browser bundles. The leading `typeof === "undefined"` keeps
// it safe at runtime in Node/vitest where `__BROWSER__` is never defined.
declare const __BROWSER__: boolean | undefined;

export const runtimeLoaders: LazyCommandDef<
  PythonCommandName | JavaScriptCommandName
>[] = [];

if (typeof __BROWSER__ === "undefined" || !__BROWSER__) {
  // Python commands
  runtimeLoaders.push({
    name: "python3",
    load: async () => (await import("../python3/python3.js")).python3Command,
  });
  runtimeLoaders.push({
    name: "python",
    load: async () => (await import("../python3/python3.js")).pythonCommand,
  });

  // JS commands
  runtimeLoaders.push({
    name: "js-exec",
    load: async () => (await import("../js-exec/js-exec.js")).jsExecCommand,
  });
  runtimeLoaders.push({
    name: "node",
    load: async () => (await import("../js-exec/js-exec.js")).nodeStubCommand,
  });
}

export const networkLoaders: LazyCommandDef<NetworkCommandName>[] = [
  {
    name: "curl",
    load: async () => (await import("../curl/curl.js")).curlCommand,
  },
];

import type { LazyCommandDef } from "../lib.js";
import type {
  JavaScriptCommandName,
  NetworkCommandName,
  PythonCommandName,
} from "../registry.js";

// __BROWSER__ is defined by esbuild at build time for browser bundles
declare const __BROWSER__: boolean | undefined;
const isBrowser = typeof __BROWSER__ !== "undefined" && __BROWSER__;

export const runtimeLoaders: LazyCommandDef<
  PythonCommandName | JavaScriptCommandName
>[] = [];

if (!isBrowser) {
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

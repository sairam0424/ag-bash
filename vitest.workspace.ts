import type { TestProjectConfiguration } from "vitest/config";

/**
 * Vitest Workspace Configuration
 * Consolidates unit and isolated (WASM/Security) test projects.
 */
const config: TestProjectConfiguration[] = [
  "./vitest.unit.config.ts",
  "./vitest.wasm.config.ts",
];

export default config;

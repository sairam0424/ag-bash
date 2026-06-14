import type { InitialFiles } from "../fs/interface.js";

/**
 * A minimal project structure with just a README and a source file.
 */
export const EMPTY_PROJECT: InitialFiles = {
  "/project/README.md": "# Test Project\n",
  "/project/src/index.ts": 'export const hello = "world";\n',
};

/**
 * A typical Node.js project with package.json, tsconfig, and source.
 */
export const NODE_PROJECT: InitialFiles = {
  "/project/package.json": JSON.stringify(
    { name: "test", version: "1.0.0", scripts: { test: "echo ok" } },
    null,
    2,
  ),
  "/project/src/index.ts": "export function main() { return 0; }\n",
  "/project/tsconfig.json": JSON.stringify(
    { compilerOptions: { strict: true } },
    null,
    2,
  ),
  "/project/node_modules/.package-lock.json": "{}",
};

/**
 * A simulated git repository with .git directory and source files.
 */
export const GIT_REPO: InitialFiles = {
  "/repo/.git/HEAD": "ref: refs/heads/main\n",
  "/repo/.git/config": "[core]\n\tbare = false\n",
  "/repo/README.md": "# Repo\n",
  "/repo/src/app.ts": 'console.log("app");\n',
};

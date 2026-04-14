#!/usr/bin/env node

import { version } from "../index.js";

async function main() {
  console.log(`Ag-Bash CLI v${version()}`);
  console.log("Unified Agentic Bash for Ag-Bash");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

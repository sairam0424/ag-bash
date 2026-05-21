import { Bash } from "./packages/bash/src/Bash.js";

async function runDemo() {
  console.log("🚀 Starting Hyperion Document Intelligence Demo...");

  const bash = new Bash({
    cwd: process.cwd(),
    python: true, // Enable python support
  });

  // 1. Setup (Optional if already installed)
  console.log("\n--- Step 1: Dependencies Setup ---");
  const setupResult = await bash.exec("ag-convert --setup");
  console.log(setupResult.stdout || setupResult.stderr);

  // 2. Convert CSV
  console.log("\n--- Step 2: Converting CSV to High-Fidelity Markdown ---");
  const csvResult = await bash.exec("ag-convert demo_data.csv");
  console.log("Output Markdown:");
  console.log("--------------------------------------------------");
  console.log(csvResult.stdout);
  console.log("--------------------------------------------------");

  console.log("\n✅ Demo Complete!");
}

runDemo().catch(console.error);

import type { Command, CommandContext, ExecResult } from "../../types.js";
import { VERSION } from "../../version.js";
import { showHelp } from "../help.js";

const doctorHelp = {
  name: "doctor",
  summary: "verify ag-bash environment health",
  usage: "doctor [OPTIONS]",
  options: [
    "--quick     only run essential checks (fast)",
    "--verbose   show detailed output for each check",
  ],
  examples: [
    "doctor           # run all checks",
    "doctor --quick   # fast essential checks only",
  ],
};

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
  skipped?: boolean;
}

async function runCheck(
  ctx: CommandContext,
  name: string,
  script: string,
  expectedOutput?: string,
): Promise<CheckResult> {
  if (!ctx.exec) {
    return { name, passed: false, detail: "exec not available" };
  }
  try {
    const result = await ctx.exec(script, { cwd: ctx.cwd });
    if (result.exitCode !== 0) {
      return {
        name,
        passed: false,
        detail: result.stderr.trim() || `exit code ${result.exitCode}`,
      };
    }
    if (
      expectedOutput !== undefined &&
      !result.stdout.includes(expectedOutput)
    ) {
      return {
        name,
        passed: false,
        detail: `expected "${expectedOutput}", got "${result.stdout.trim()}"`,
      };
    }
    return { name, passed: true, detail: result.stdout.trim() };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, passed: false, detail: msg };
  }
}

export const doctorCommand: Command = {
  name: "doctor",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    if (args.includes("--help") || args.includes("-h")) {
      return showHelp(doctorHelp);
    }

    const quick = args.includes("--quick");
    const verbose = args.includes("--verbose");
    const results: CheckResult[] = [];
    let output = `ag-bash doctor v${VERSION} — Environment Health Check\n\n`;

    // CORE ENGINE CHECKS
    output += "CORE ENGINE\n";
    const coreChecks = [
      {
        name: "Interpreter operational",
        script: "echo hello",
        expected: "hello",
      },
      { name: "Variable expansion", script: "x=42; echo $x", expected: "42" },
      { name: "Pipe execution", script: "echo test | cat", expected: "test" },
      {
        name: "Command substitution",
        script: "echo $(echo nested)",
        expected: "nested",
      },
      {
        name: "Arithmetic expansion",
        script: "echo $((2 + 3))",
        expected: "5",
      },
    ];

    for (const check of coreChecks) {
      const r = await runCheck(ctx, check.name, check.script, check.expected);
      results.push(r);
      output += r.passed
        ? `  * ${r.name}\n`
        : `  x ${r.name} — FAILED${r.detail ? `: ${r.detail}` : ""}\n`;
      if (verbose && r.detail) output += `    ${r.detail}\n`;
    }
    output += "\n";

    // FILESYSTEM CHECKS
    output += "FILESYSTEM\n";
    const fsChecks = [
      {
        name: "File write/read",
        script: "echo content > /tmp/doctor_test && cat /tmp/doctor_test",
        expected: "content",
      },
      {
        name: "Directory creation",
        script: "mkdir -p /tmp/doctor_dir && ls -d /tmp/doctor_dir",
        expected: "/tmp/doctor_dir",
      },
      {
        name: "File deletion",
        script: "rm /tmp/doctor_test && test ! -f /tmp/doctor_test && echo ok",
        expected: "ok",
      },
    ];

    for (const check of fsChecks) {
      const r = await runCheck(ctx, check.name, check.script, check.expected);
      results.push(r);
      output += r.passed
        ? `  * ${r.name}\n`
        : `  x ${r.name} — FAILED${r.detail ? `: ${r.detail}` : ""}\n`;
      if (verbose && r.detail) output += `    ${r.detail}\n`;
    }
    output += "\n";

    if (!quick) {
      // COMMAND CHECKS
      const registered = ctx.getRegisteredCommands
        ? ctx.getRegisteredCommands()
        : [];
      output += `COMMANDS (${registered.length} registered)\n`;
      const commandChecks = [
        {
          name: "Core I/O (echo, cat, ls)",
          script: "echo ok && cat /dev/null && ls / > /dev/null && echo pass",
          expected: "pass",
        },
        {
          name: "Text processing (grep, sort)",
          script: "echo hello | grep hello && echo a | sort && echo pass",
          expected: "pass",
        },
        {
          name: "Data (jq, base64)",
          script: "echo '{\"a\":1}' | jq .a && echo pass",
          expected: "pass",
        },
      ];

      for (const check of commandChecks) {
        const r = await runCheck(ctx, check.name, check.script, check.expected);
        results.push(r);
        output += r.passed
          ? `  * ${r.name}\n`
          : `  x ${r.name} — FAILED${r.detail ? `: ${r.detail}` : ""}\n`;
        if (verbose && r.detail) output += `    ${r.detail}\n`;
      }
      output += "\n";

      // FEATURE CHECKS
      output += "FEATURES\n";
      const featureChecks = [
        { name: "Brace expansion", script: "echo {1..3}", expected: "1 2 3" },
        {
          name: "Parameter default",
          script: "echo ${UNSET_VAR:-fallback}",
          expected: "fallback",
        },
        {
          name: "Glob expansion",
          script:
            "mkdir -p /tmp/dglob && touch /tmp/dglob/a.txt /tmp/dglob/b.txt && ls /tmp/dglob/*.txt | wc -l",
          expected: "2",
        },
        {
          name: "Conditional execution",
          script: "true && echo yes || echo no",
          expected: "yes",
        },
      ];

      for (const check of featureChecks) {
        const r = await runCheck(ctx, check.name, check.script, check.expected);
        results.push(r);
        output += r.passed
          ? `  * ${r.name}\n`
          : `  x ${r.name} — FAILED${r.detail ? `: ${r.detail}` : ""}\n`;
        if (verbose && r.detail) output += `    ${r.detail}\n`;
      }
      output += "\n";

      // OPTIONAL RUNTIMES
      output += "OPTIONAL RUNTIMES\n";
      const runtimeChecks: Array<{
        name: string;
        script: string;
        flag: string;
      }> = [
        {
          name: "Python3 (WASM)",
          script: "python3 -c 'print(1+1)'",
          flag: "--python",
        },
        {
          name: "JavaScript (QuickJS)",
          script: "js-exec -e 'console.log(1+1)'",
          flag: "--javascript",
        },
        {
          name: "Network (curl)",
          script: "echo network-check",
          flag: "--allow-network",
        },
      ];

      for (const check of runtimeChecks) {
        if (!ctx.exec) {
          results.push({ name: check.name, passed: false, skipped: true });
          output += `  - ${check.name} (not available)\n`;
          continue;
        }
        const r = await runCheck(ctx, check.name, check.script);
        if (!r.passed) {
          output += `  - ${check.name} (not enabled — use ${check.flag})\n`;
          results.push({ ...r, skipped: true });
        } else {
          output += `  * ${check.name}\n`;
          results.push(r);
        }
      }
      output += "\n";
    }

    // SUMMARY
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    const total = passed + failed;

    if (failed === 0) {
      output += `RESULT: ${passed}/${total} checks passed *\n`;
    } else {
      output += `RESULT: ${passed}/${total} checks passed, ${failed} FAILED\n`;
    }
    if (skipped > 0) {
      output += `       (${skipped} optional checks skipped)\n`;
    }

    return { stdout: output, stderr: "", exitCode: failed > 0 ? 1 : 0 };
  },
};

/**
 * Ag-Bash Theme Utility — "The Universal Architect"
 * Rigid, high-fidelity CLI aesthetic with neon highlights.
 */

const TTY = process.stdout.isTTY;

interface ThemeStats {
  commands: number;
  filesystems: number;
  python: string;
  javascript: string;
  security: string;
  benchmarks: string;
  coverage: string;
}

export const Theme: {
  colors: {
    reset: (s: string) => string;
    cyan: (s: string) => string;
    green: (s: string) => string;
    yellow: (s: string) => string;
    red: (s: string) => string;
    dim: (s: string) => string;
    bold: (s: string) => string;
    italic: (s: string) => string;
    magenta: (s: string) => string;
    orange: (s: string) => string;
  };
  chars: {
    top: string;
    bottom: string;
    side: string;
    divider: string;
    bullet: string;
    resolved: string;
    check: string;
    cross: string;
    arrow: string;
    prompt: string;
  };
  logo: string;
  tagline: string;
  /**
   * Print a styled header with BMad-style border flare
   */
  printHeader(version: string): void;
  /**
   * Print Brand Manifest
   */
  printBrandManifest(): void;
  printPrompt(label: string): void;
  printResolved(label: string): void;
  /**
   * Success Banner
   */
  printSuccess(
    runtime: string,
    scope: string,
    stats?: Partial<ThemeStats>,
  ): void;
  /**
   * Print Manifest
   */
  printManifest(stats?: Partial<ThemeStats>): void;
  /**
   * Print a status line
   */
  printStatus(label: string, state?: "done" | "fail" | "info" | "warn"): void;

  /**
   * Print Power Suite
   */
  printPowerSuite(): void;
} = {
  colors: {
    reset: (s: string): string => (TTY ? `${s}\x1b[0m` : s),
    cyan: (s: string): string => (TTY ? `\x1b[36m${s}\x1b[0m` : s),
    green: (s: string): string => (TTY ? `\x1b[32m${s}\x1b[0m` : s),
    yellow: (s: string): string => (TTY ? `\x1b[33m${s}\x1b[0m` : s),
    red: (s: string): string => (TTY ? `\x1b[31m${s}\x1b[0m` : s),
    dim: (s: string): string => (TTY ? `\x1b[2m${s}\x1b[0m` : s),
    bold: (s: string): string => (TTY ? `\x1b[1m${s}\x1b[0m` : s),
    italic: (s: string): string => (TTY ? `\x1b[3m${s}\x1b[0m` : s),
    magenta: (s: string): string => (TTY ? `\x1b[35m${s}\x1b[0m` : s), // Security / Quantum
    orange: (s: string): string => (TTY ? `\x1b[38;5;208m${s}\x1b[0m` : s), // Alerts
  },

  chars: {
    top: "┌──────────────────────────────────────────────────────────────────────────────┐",
    bottom:
      "└──────────────────────────────────────────────────────────────────────────────┘",
    side: "│",
    divider:
      "├──────────────────────────────────────────────────────────────────────────────┤",
    bullet: "◇",
    resolved: "●",
    check: "✓",
    cross: "✘",
    arrow: "→",
    prompt: "❯",
  },

  logo: [
    " █████╗  ██████╗ ██████╗  █████╗ ███████╗██╗  ██╗",
    "██╔══██╗██╔════╝ ██╔══██╗██╔══██╗██╔════╝██║  ██║",
    "███████║██║  ███╗██████╔╝███████║███████╗███████║",
    "██╔══██║██║   ██║██╔══██╗██╔══██║╚════██║██╔══██║",
    "██║  ██║╚██████╔╝██████╔╝██║  ██║███████║██║  ██║",
    "╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝",
  ].join("\n"),

  tagline: "SECURE UNIFIED AGENTIC BASH RUNTIME",

  /**
   * Print a styled header with BMad-style border flare
   */
  printHeader(version: string) {
    const c = this.colors;
    const topBar = "─".repeat(78);
    const bottomBar = "─".repeat(78);

    console.log(`\n  ${c.dim(`┌${topBar}┐`)}`);
    for (const line of this.logo.split("\n")) {
      console.log(`  ${c.dim("│")}  ${c.cyan(line.padEnd(74))}  ${c.dim("│")}`);
    }
    console.log(
      `  ${c.dim("│")}  ${c.bold(this.tagline.padEnd(74))}  ${c.dim("│")}`,
    );
    console.log(
      `  ${c.dim("│")}  ${c.dim(`RELEASE v${version}`.padEnd(74))}  ${c.dim("│")}`,
    );
    console.log(`  ${c.dim(`└${bottomBar}┘`)}\n`);
  },

  /**
   * Print Brand Manifest
   */
  printBrandManifest() {
    const c = this.colors;
    const divider = "─".repeat(80);
    console.log(`  ${c.dim("│")}`);
    console.log(
      `  ${c.dim("│")}  ${c.magenta("🛡️  SECURE EXECUTION v1.0.0")} — OverlayFS & WASM Sandbox Enabled`,
    );
    console.log(`  ${c.dim("│")}`);
    console.log(`  ${c.dim("│")}  ${c.bold("THE PLATFORM VISION:")}`);
    console.log(`  ${c.dim("│")}    - Unified Agentic Bash for AI Workflows`);
    console.log(
      `  ${c.dim("│")}    - Byte-Transparent Filesystem Virtualization`,
    );
    console.log(
      `  ${c.dim("│")}    - ${c.magenta("Defense-in-Depth")}: Hardened Global Sandboxing`,
    );
    console.log(
      `  ${c.dim("│")}    - Multi-Runtime Support (WASM, JS, Python)`,
    );
    console.log(`  ${c.dim("│")}`);
    console.log(`  ${c.dim("│")}  ${c.bold("CORE USPs:")}`);
    console.log(
      `  ${c.dim("│")}    - ${c.bold("Byte-Transparent")}: 1:1 local-to-virtual mirroring`,
    );
    console.log(
      `  ${c.dim("│")}    - ${c.bold("Isolated Execution")}: Secure wasm-based task isolation`,
    );
    console.log(
      `  ${c.dim("│")}    - ${c.bold("Cross-Runtime")}: Unified Bash/Python/JS synergy`,
    );
    console.log(`  ${c.dim("│")}`);
    console.log(`  ${c.dim("│")}  ${c.yellow("🌟 100% FREE & OPEN SOURCE")}`);
    console.log(`  ${c.dim("│")}    - Built for the Agentic Era.`);
    console.log(
      `  ${c.dim("│")}    - Empowering developers with secure AI tools.`,
    );
    console.log(`  ${c.dim("│")}`);
    console.log(`  ${c.dim("│")}  ${c.cyan("⭐ CONNECT & CONTRIBUTE:")}`);
    console.log(
      `  ${c.dim("│")}    - GitHub:  ${c.dim("https://github.com/sairam0424/ag-bash")}`,
    );
    console.log(`  ${c.dim("│")}`);
    console.log(`  ${c.dim(`${divider}`)}\n`);
  },

  printPrompt(label: string) {
    console.log(`  ${this.colors.cyan(this.chars.bullet)}  ${label}`);
  },

  printResolved(label: string) {
    console.log(`  ${this.colors.green(this.chars.resolved)}  ${label}`);
  },

  /**
   * Success Banner
   */
  printSuccess(
    runtime: string,
    scope: string,
    stats: Partial<ThemeStats> = {},
  ) {
    const c = this.colors;
    const boxWidth = 72;
    const bar = "─".repeat(boxWidth - 20);
    const bottomBar = "─".repeat(boxWidth);

    console.log(`\n  ${c.green("AG-BASH is ready! ")} ${c.dim(`${bar}`)}╮`);
    console.log(
      `  ${c.dim("│")}                                                                        ${c.dim("│")}`,
    );
    console.log(
      `  ${c.dim("│")}    ${c.green("✓")}  ${c.bold("Ag-Bash Core")}   (installed)                             ${c.dim("│")}`,
    );
    console.log(
      `  ${c.dim("│")}    ${c.green("✓")}  ${c.bold("WASM Runtime")}   (active)                                ${c.dim("│")}`,
    );
    console.log(
      `  ${c.dim("│")}    ${c.green("✓")}  ${c.bold("OverlayFS")}      (mounted)                               ${c.dim("│")}`,
    );
    console.log(
      `  ${c.dim("│")}                                                                        ${c.dim("│")}`,
    );
    console.log(
      `  ${c.dim("│")}    ${c.bold("Environment")}: ${c.cyan(runtime)} (${c.dim(scope)})                         ${c.dim("│")}`,
    );
    console.log(
      `  ${c.dim("│")}                                                                        ${c.dim("│")}`,
    );
    console.log(
      `  ${c.dim("│")}    ${c.bold("Next steps:")}                                                   ${c.dim("│")}`,
    );
    console.log(
      `  ${c.dim("│")}      ${c.bold("ag-bash --help")}   ${c.dim("— Explore the command suite")}                ${c.dim("│")}`,
    );
    console.log(
      `  ${c.dim("│")}      ${c.bold("ag-shell")}         ${c.dim("— Launch interactive environment")}           ${c.dim("│")}`,
    );
    console.log(
      `  ${c.dim("│")}                                                                        ${c.dim("│")}`,
    );
    console.log(`  ${c.dim(`├${bottomBar}╯`)}\n`);

    this.printManifest(stats);
  },

  /**
   * Print Manifest
   */
  printManifest(stats: Partial<ThemeStats> = {}) {
    const c = this.colors;
    const {
      commands = 100,
      filesystems = 2,
      python = "Available",
      javascript = "Available",
      security = "Defense-in-Depth",
      benchmarks = "Verified",
      coverage = "Equivalence",
    } = stats;
    const bar = "─".repeat(74);

    console.log(`  ${c.bold("PAYLOAD MANIFEST")}`);
    console.log(`  ${c.dim(`┌${bar}┐`)}`);

    const rows = [
      ["COMMANDS", commands.toString(), "Statically analyzable built-ins"],
      ["FILESYSTEMS", filesystems.toString(), "OverlayFS & InMemoryFS layers"],
      ["PYTHON", python, "CPython Emscripten integration"],
      ["JAVASCRIPT", javascript, "QuickJS virtualization engine"],
      ["SECURITY", security, "Global global monkey-patching"],
      ["VALIDATION", coverage, "Feature equivalence test suite"],
      ["PERFORMANCE", benchmarks, "Low-overhead execution profiling"],
    ];

    for (const [label, value, desc] of rows) {
      const valStr = value.padEnd(8);
      console.log(
        `  ${c.dim("│")}  ${c.cyan("█")} ${c.bold(label.padEnd(14))} ${c.cyan(valStr)}   ${c.dim(desc.padEnd(45))} ${c.dim("│")}`,
      );
    }

    console.log(`  ${c.dim(`└${bar}┘`)}\n`);
  },

  /**
   * Print a status line
   */
  printStatus(
    label: string,
    state: "done" | "fail" | "info" | "warn" = "info",
  ) {
    const icons = {
      done: this.colors.green(this.chars.resolved),
      fail: this.colors.red(this.chars.cross),
      info: this.colors.cyan(this.chars.bullet),
      warn: this.colors.yellow("!"),
    };
    console.log(`  ${icons[state] || icons.info}  ${label}`);
  },

  /**
   * Print Power Suite
   */
  printPowerSuite() {
    const c = this.colors;
    const bar = "─".repeat(74);
    console.log(`  ${c.bold("THE POWER SUITE")}`);
    console.log(`  ${c.dim(`┌${bar}┐`)}`);

    const suite = [
      {
        category: "DATA",
        tools: ["jq", "yq", "xan", "sqlite3", "html-to-markdown"],
      },
      { category: "LOGIC", tools: ["python3", "js-exec", "awk", "sed"] },
      { category: "SECURITY", tools: ["sha256sum", "md5sum", "chmod", "stat"] },
      { category: "INTEL", tools: ["rg", "tree", "find", "tar"] },
      { category: "NETWORK", tools: ["curl (isolated)"] },
    ];

    for (const { category, tools } of suite) {
      console.log(
        `  ${c.dim("│")}  ${c.yellow("█")} ${c.bold(
          category.padEnd(10),
        )} ${c.reset(tools.join(", ").padEnd(59))} ${c.dim("│")}`,
      );
    }

    console.log(`  ${c.dim(`└${bar}┘`)}\n`);
  },
};

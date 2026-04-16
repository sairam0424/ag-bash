/**
 * Ag-Bash Theme Utility — "The Universal Architect"
 * Rigid, high-fidelity CLI aesthetic with neon highlights.
 */

const TTY = process.stdout.isTTY;

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
  }; chars: {
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
  }; logo: string; tagline: string;
  /**
   * Print a styled header with BMad-style border flare
   */
  printHeader(version: string): void;
  /**
   * Print Brand Manifest
   */
  printBrandManifest(): void; printPrompt(label: string): void; printResolved(label: string): void;
  /**
   * Success Banner
   */
  printSuccess(runtime: string, scope: string, stats?: any): void;
  /**
   * Print Manifest
   */
  printManifest(stats?: any): void;
  /**
   * Print a status line
   */
  printStatus(label: string, state?: "done" | "fail" | "info" | "warn"): void;
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
    top: '┌──────────────────────────────────────────────────────────────────────────────┐',
    bottom: '└──────────────────────────────────────────────────────────────────────────────┘',
    side: '│',
    divider: '├──────────────────────────────────────────────────────────────────────────────┤',
    bullet: '◇',
    resolved: '●',
    check: '✓',
    cross: '✘',
    arrow: '→',
    prompt: '❯',
  },

  logo: [
    ' █████╗  ██████╗ ██████╗  █████╗ ███████╗██╗  ██╗',
    '██╔══██╗██╔════╝ ██╔══██╗██╔══██╗██╔════╝██║  ██║',
    '███████║██║  ███╗██████╔╝███████║███████╗███████║',
    '██╔══██║██║   ██║██╔══██╗██╔══██║╚════██║██╔══██║',
    '██║  ██║╚██████╔╝██████╔╝██║  ██║███████║██║  ██║',
    '╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝'
  ].join('\n'),

  tagline: 'SECURE UNIFIED AGENTIC BASH RUNTIME',

  /**
   * Print a styled header with BMad-style border flare
   */
  printHeader(version: string) {
    const c = this.colors;
    console.log(`\n  ${c.dim('┌' + '─'.repeat(78) + '┐')}`);
    this.logo.split('\n').forEach(line => {
      console.log(`  ${c.dim('│')}  ${c.cyan(line.padEnd(74))}  ${c.dim('│')}`);
    });
    console.log(`  ${c.dim('│')}  ${c.bold(this.tagline.padEnd(74))}  ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}  ${c.dim(`RELEASE v${version}`.padEnd(74))}  ${c.dim('│')}`);
    console.log(`  ${c.dim('└' + '─'.repeat(78) + '┘')}\n`);
  },

  /**
   * Print Brand Manifest
   */
  printBrandManifest() {
    const c = this.colors;
    console.log(`  ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}  ${c.magenta('🛡️  SECURE EXECUTION v1.0.0')} — OverlayFS & WASM Sandbox Enabled`);
    console.log(`  ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}  ${c.bold('THE PLATFORM VISION:')}`);
    console.log(`  ${c.dim('│')}    - Unified Agentic Bash for AI Workflows`);
    console.log(`  ${c.dim('│')}    - Byte-Transparent Filesystem Virtualization`);
    console.log(`  ${c.dim('│')}    - ${c.magenta('Defense-in-Depth')}: Hardened Global Sandboxing`);
    console.log(`  ${c.dim('│')}    - Multi-Runtime Support (WASM, JS, Python)`);
    console.log(`  ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}  ${c.yellow('🌟 100% FREE & OPEN SOURCE')}`);
    console.log(`  ${c.dim('│')}    - Built for the Agentic Era.`);
    console.log(`  ${c.dim('│')}    - Empowering developers with secure AI tools.`);
    console.log(`  ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}  ${c.cyan('⭐ CONNECT & CONTRIBUTE:')}`);
    console.log(`  ${c.dim('│')}    - GitHub:  ${c.dim('https://github.com/sairam0424/ag-bash')}`);
    console.log(`  ${c.dim('│')}    - Discord: ${c.dim('https://discord.gg/mindforge')}`);
    console.log(`  ${c.dim('│')}    - Docs:    ${c.dim('https://docs.mindforge.cc')}`);
    console.log(`  ${c.dim('│')}`);
    console.log(`  ${c.dim('—'.repeat(80))}\n`);
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
  printSuccess(runtime: string, scope: string, stats: any = {}) {
    const c = this.colors;
    const { commands = 100, filesystems = 2, benchmarks = 'Verified' } = stats;
    const boxWidth = 72;

    console.log(`\n  ${c.green('AG-BASH is ready! ')} ${c.dim('─'.repeat(boxWidth - 20))}╮`);
    console.log(`  ${c.dim('│')}                                                                        ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}    ${c.green('✓')}  ${c.bold('Ag-Bash Core')}   (installed)                             ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}    ${c.green('✓')}  ${c.bold('WASM Runtime')}   (active)                                ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}    ${c.green('✓')}  ${c.bold('OverlayFS')}      (mounted)                               ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}                                                                        ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}    ${c.bold('Environment')}: ${c.cyan(runtime)} (${c.dim(scope)})                         ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}                                                                        ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}    ${c.bold('Next steps:')}                                                   ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}      ${c.bold('ag-bash --help')}   ${c.dim('— Explore the command suite')}                ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}      ${c.bold('ag-shell')}         ${c.dim('— Launch interactive environment')}           ${c.dim('│')}`);
    console.log(`  ${c.dim('│')}                                                                        ${c.dim('│')}`);
    console.log(`  ${c.dim('├' + '─'.repeat(boxWidth) + '╯')}\n`);

    this.printManifest(stats);
  },

  /**
   * Print Manifest
   */
  printManifest(stats: any = {}) {
    const c = this.colors;
    const { 
      commands = 100, 
      filesystems = 2, 
      python = 'Available', 
      javascript = 'Available', 
      security = 'Defense-in-Depth',
      benchmarks = 'Verified',
      coverage = 'Equivalence'
    } = stats;
    
    console.log(`  ${c.bold('PAYLOAD MANIFEST')}`);
    console.log(`  ${c.dim('┌' + '─'.repeat(74) + '┐')}`);
    
    const rows = [
      ['COMMANDS', commands.toString(), 'Statically analyzable built-ins'],
      ['FILESYSTEMS', filesystems.toString(), 'OverlayFS & InMemoryFS layers'],
      ['PYTHON', python, 'CPython Emscripten integration'],
      ['JAVASCRIPT', javascript, 'QuickJS virtualization engine'],
      ['SECURITY', security, 'Global global monkey-patching'],
      ['VALIDATION', coverage, 'Feature equivalence test suite'],
      ['PERFORMANCE', benchmarks, 'Low-overhead execution profiling'],
    ];

    rows.forEach(([label, value, desc]) => {
      const valStr = value.padEnd(8);
      console.log(`  ${c.dim('│')}  ${c.cyan('█')} ${c.bold(label.padEnd(14))} ${c.cyan(valStr)}   ${c.dim(desc.padEnd(45))} ${c.dim('│')}`);
    });

    console.log(`  ${c.dim('└' + '─'.repeat(74) + '┘')}\n`);
  },

  /**
   * Print a status line
   */
  printStatus(label: string, state: 'done' | 'fail' | 'info' | 'warn' = 'info') {
    const icons = {
      done: this.colors.green(this.chars.resolved),
      fail: this.colors.red(this.chars.cross),
      info: this.colors.cyan(this.chars.bullet),
      warn: this.colors.yellow('!'),
    };
    console.log(`  ${icons[state] || icons.info}  ${label}`);
  },
};

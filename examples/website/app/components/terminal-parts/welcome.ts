import { ASCII_ART } from "./constants";

type Terminal = {
  write: (data: string) => void;
  writeln: (data: string) => void;
  cols: number;
};

export function showWelcome(term: Terminal) {
  term.writeln("");

  // Only show ASCII art if terminal is wide enough (43+ chars)
  if (term.cols >= 43) {
    for (const line of ASCII_ART) {
      term.writeln(line);
    }
  } else {
    term.writeln("\x1b[38;5;42m  ◈ Ag-Bash v1.1.0 \x1b[38;5;242m| \x1b[38;5;45mDigital Architect Edition\x1b[0m");
    term.writeln("\x1b[2m  High-fidelity WASM/OverlayFS shell for agentic workflows\x1b[0m");
    term.writeln("");
    term.writeln("  \x1b[1m\x1b[38;5;42m$ npm install @ag-bash/bash\x1b[0m");
    term.writeln("");
    term.writeln("\x1b[2m  import { Bash } from '@ag-bash/bash';\x1b[0m");
    term.writeln("\x1b[2m  const bash = new Bash({ persistState: true });\x1b[0m");
    term.writeln("\x1b[2m  await bash.exec('python3 data_analysis.py');\x1b[0m");
    term.writeln("");
    term.writeln(
      "\x1b[2mCommands:\x1b[0m \x1b[38;5;42mabout\x1b[0m, \x1b[38;5;42minstall\x1b[0m, \x1b[38;5;42mgithub\x1b[0m, \x1b[38;5;42magent\x1b[0m, \x1b[38;5;42mhelp\x1b[0m"
    );
    term.writeln(
      "\x1b[2mTry:\x1b[0m \x1b[38;5;42mls -R\x1b[0m, \x1b[38;5;42mcat\x1b[0m README.md | \x1b[38;5;42mgrep\x1b[0m bash, \x1b[38;5;42mtree\x1b[0m, \x1b[38;5;42mpython3\x1b[0m --version"
    );
  }
  term.writeln("");
  term.write("$ ");
}
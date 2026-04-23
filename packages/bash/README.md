# @ag-bash/bash

A virtual bash environment with an in-memory filesystem, written in TypeScript and designed for AI agents.

Broad support for standard unix commands and bash syntax with optional curl, Python, JS/TS, and sqlite support.

**Note**: This is beta software. Use at your own risk and please provide feedback. See [security model](#security-model).

## Installation

### Globally (CLI & Shell)

#### Via Homebrew (macOS)
```bash
brew tap ag-bash/homebrew-tap
brew install ag-bash
```

#### Via NPM
```bash
npm install -g @ag-bash/bash
```

### As a Library

```bash
npm install @ag-bash/bash
```

```typescript
import { Bash } from "@ag-bash/bash";

const bash = new Bash();
await bash.exec('echo "Hello" > greeting.txt');
const result = await bash.exec("cat greeting.txt");
console.log(result.stdout); // "Hello\n"
console.log(result.exitCode); // 0
```

Each `exec()` call gets its own isolated shell state — environment variables, functions, and working directory reset between calls. The **filesystem is shared** across calls, so files written in one `exec()` are visible in the next.

## Custom Commands

Extend @ag-bash/bash with your own TypeScript commands using `defineCommand`:

```typescript
import { Bash, defineCommand } from "@ag-bash/bash";

const hello = defineCommand("hello", async (args, ctx) => {
  const name = args[0] || "world";
  return { stdout: `Hello, ${name}!\n`, stderr: "", exitCode: 0 };
});

const upper = defineCommand("upper", async (args, ctx) => {
  return { stdout: ctx.stdin.toUpperCase(), stderr: "", exitCode: 0 };
});

const bash = new Bash({ customCommands: [hello, upper] });

await bash.exec("hello Alice"); // "Hello, Alice!\n"
await bash.exec("echo 'test' | upper"); // "TEST\n"
```

Custom commands receive a `CommandContext` with `fs`, `cwd`, `env`, `stdin`, and `exec` (for subcommands), and work with pipes, redirections, and all shell features.

<details>
<summary><h2>Supported Commands</h2></summary>

### File Operations

`cat`, `cp`, `file`, `ln`, `ls`, `mkdir`, `mv`, `readlink`, `rm`, `rmdir`, `split`, `stat`, `touch`, `tree`

### Text Processing

`awk`, `base64`, `column`, `comm`, `cut`, `diff`, `expand`, `fold`, `grep` (+ `egrep`, `fgrep`), `head`, `join`, `md5sum`, `nl`, `od`, `paste`, `printf`, `rev`, `rg`, `sed`, `sha1sum`, `sha256sum`, `sort`, `strings`, `tac`, `tail`, `tr`, `unexpand`, `uniq`, `wc`, `xargs`

### Data Processing

`jq` (JSON), `sqlite3` (SQLite), `xan` (CSV), `yq` (YAML/XML/TOML/CSV)

### Optional Runtimes

`js-exec` (JavaScript/TypeScript via QuickJS; requires `javascript: true`), `python3`/`python` (Python via CPython; requires `python: true`)

### Compression & Archives

`gzip` (+ `gunzip`, `zcat`), `tar`

### Navigation & Environment

`basename`, `cd`, `dirname`, `du`, `echo`, `env`, `export`, `find`, `hostname`, `printenv`, `pwd`, `tee`

### Shell Utilities

`alias`, `bash`, `chmod`, `clear`, `date`, `expr`, `false`, `hello`, `help`, `history`, `seq`, `sh`, `sleep`, `time`, `timeout`, `true`, `unalias`, `which`, `whoami`

### Agentic Operations (v2.0.0+)

Specialized commands designed for AI agents to interact with the environment effectively:

- `ag-edit`: Robust, line-based file editing (insert/replace/delete).
- `ag-diff`: High-fidelity, semantic diff for code changes.
- `ag-snapshot`: Capture and restore core shell state (env, functions, CWD, and FS).
- `ag-analyze`: Structural analysis of Bash scripts with symbol table extraction.
- `ag-hover`: Retrieve metadata and documentation for a symbol at a specific location.
- `ag-explain`: Parse and explain the structure of complex shell commands.
- `ag-find-symbol`: Workspace-wide search for symbol definitions and references.
- `ag-todo`: Persistent local task management for agentic project tracking.

All commands support `--help` for usage information.

### Shell Features

- **Pipes**: `cmd1 | cmd2`
- **Redirections**: `>`, `>>`, `2>`, `2>&1`, `<`
- **Command chaining**: `&&`, `||`, `;`
- **Variables**: `$VAR`, `${VAR}`, `${VAR:-default}`
- **Positional parameters**: `$1`, `$2`, `$@`, `$#`
- **Glob patterns**: `*`, `?`, `[...]`
- **If statements**: `if COND; then CMD; elif COND; then CMD; else CMD; fi`
- **Functions**: `function name { ... }` or `name() { ... }`
- **Local variables**: `local VAR=value`
- **Loops**: `for`, `while`, `until`
- **Symbolic links**: `ln -s target link`
- **Hard links**: `ln target link`

</details>

## Configuration

```typescript
const env = new Bash({
  files: { "/data/file.txt": "content" }, // Initial files
  env: { MY_VAR: "value" }, // Initial environment
  cwd: "/app", // Starting directory (default: /home/user)
  executionLimits: { maxCallDepth: 50 }, // See "Execution Protection"
  python: true, // Enable python3/python commands
  javascript: true, // Enable js-exec command
  // Or with bootstrap: javascript: { bootstrap: "globalThis.X = 1;" }
});

// Per-exec overrides
await env.exec("echo $TEMP", { env: { TEMP: "value" }, cwd: "/tmp" });

// Pass stdin to the script
await env.exec("cat", { stdin: "hello from stdin\n" });

// Start with a clean environment
await env.exec("env", { replaceEnv: true, env: { ONLY: "this" } });

// Pass arguments without shell escaping (like spawnSync)
await env.exec("grep", { args: ["-r", "TODO", "src/"] });

// Cancel long-running scripts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);
await env.exec("while true; do sleep 1; done", { signal: controller.signal });

// Preserve leading whitespace (e.g., for heredocs)
await env.exec("cat <<EOF\n  indented\nEOF", { rawScript: true });
```

`exec()` options:

| Option | Type | Description |
|---|---|---|
| `env` | `Record<string, string>` | Environment variables for this execution only |
| `cwd` | `string` | Working directory for this execution only |
| `stdin` | `string` | Standard input passed to the script |
| `args` | `string[]` | Additional argv passed directly to the first command (bypasses shell parsing; does not change `$1`, `$2`, ...) |
| `replaceEnv` | `boolean` | Start with empty env instead of merging (default: `false`) |
| `signal` | `AbortSignal` | Cooperative cancellation; stops at next statement boundary |
| `rawScript` | `boolean` | Skip leading-whitespace normalization (default: `false`) |
| `persistState` | `boolean` | If true, commit env/cwd/function changes back to master instance |

## Filesystem Options

Four filesystem implementations:

**InMemoryFs** (default) - Pure in-memory filesystem, no disk access:

```typescript
import { Bash } from "@ag-bash/bash";

const env = new Bash({
  files: {
    "/data/config.json": '{"key": "value"}',
    // Lazy: called on first read, cached. Never called if written before read.
    "/data/large.csv": () => "col1,col2\na,b\n",
    "/data/remote.txt": async () => (await fetch("https://example.com")).text(),
  },
});
```

**OverlayFs** - Copy-on-write over a real directory. Reads come from disk, writes stay in memory:

```typescript
import { Bash } from "@ag-bash/bash";
import { OverlayFs } from "@ag-bash/bash/fs/overlay-fs";

const overlay = new OverlayFs({ root: "/path/to/project" });
const env = new Bash({ fs: overlay, cwd: overlay.getMountPoint() });

await env.exec("cat package.json"); // reads from disk
await env.exec('echo "modified" > package.json'); // stays in memory
```

**ReadWriteFs** - Direct read-write access to a real directory. Use this if you want the agent to be able to write to your disk:

```typescript
import { Bash } from "@ag-bash/bash";
import { ReadWriteFs } from "@ag-bash/bash/fs/read-write-fs";

const rwfs = new ReadWriteFs({ root: "/path/to/sandbox" });
const env = new Bash({ fs: rwfs });

await env.exec('echo "hello" > file.txt'); // writes to real filesystem
```

Keep `ReadWriteFs` pointed at a workspace directory, not at the installed `@ag-bash/bash` package or any other trusted runtime code. Guest-writable roots should stay separate from trusted code.

**MountableFs** - Mount multiple filesystems at different paths. Combines read-only and read-write filesystems into a unified namespace:

```typescript
import { Bash, MountableFs, InMemoryFs } from "@ag-bash/bash";
import { OverlayFs } from "@ag-bash/bash/fs/overlay-fs";
import { ReadWriteFs } from "@ag-bash/bash/fs/read-write-fs";

const fs = new MountableFs({ base: new InMemoryFs() });

// Mount read-only knowledge base
fs.mount("/mnt/knowledge", new OverlayFs({ root: "/path/to/knowledge", readOnly: true }));

// Mount read-write workspace
fs.mount("/home/agent", new ReadWriteFs({ root: "/path/to/workspace" }));

const bash = new Bash({ fs, cwd: "/home/agent" });

await bash.exec("ls /mnt/knowledge"); // reads from knowledge base
await bash.exec("cp /mnt/knowledge/doc.txt ./"); // cross-mount copy
await bash.exec('echo "notes" > notes.txt'); // writes to workspace
```

## Security Model

- The shell only has access to the provided filesystem.
- All execution happens without VM isolation. This does introduce additional risk. The code base was designed to be robust against prototype-pollution attacks and other break outs to the host JS engine and filesystem.
- There is no network access by default. When enabled, requests are checked against URL prefix allow-lists and HTTP-method allow-lists.
- Python and JavaScript execution are off by default as they represent additional security surface.

## License

Apache-2.0

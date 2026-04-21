# Agentic Runtimes Registry

Ag-Bash is a **Unified Runtime**. It breaks the barrier between shell scripting and full programming languages by running WASM-based compilers directly in the same process.

---

## 🐍 Python 3.11 Runtime

The `python3` command provides a full CPython environment. It shares the same **OverlayFS** as your Bash shell.

### Capability Highlights

- Standard library modules (os, sys, json, csv, math, etc.)
- In-memory file processing.
- Direct piping to/from Bash tools.

**Interactive Test:**

```python
# Pass output from ls to Python for processing
ls / | python3 -c "import sys; print(f'Count: {len(sys.stdin.readlines())}')"
```

---

## ⚡ JavaScript (QuickJS) Runtime

The `js-exec` command uses the **QuickJS** engine. It is ultra-lightweight and starts in milliseconds.

### Usage

- Fast JSON manipulation.
- Complex math or string logic that is hard in pure Bash.

**Interactive Test:**

```javascript
js-exec "console.log(JSON.stringify({timestamp: Date.now(), status: 'OK'}))"
```

---

## 📖 Pattern: The Cross-Runtime Synergy

The true power of Ag-Bash is piping data through all three runtimes without context switching.

**Pro Interaction Pattern:**

```bash
# 1. Fetch JSON with Curl (Bash)
# 2. Extract logic with JS (QuickJS)
# 3. Perform Stat Analysis with Python (CPython)
# 4. Format for display (JQ)

curl -s https://api.github.com/repos/sairam0424/ag-bash | \
js-exec "const d = JSON.parse(read_stdin()); print(d.stargazers_count)" | \
python3 -c "import sys; x = int(sys.stdin.read()); print(f'Stars: {x}')" | \
jq -R '.'
```

---

## 🌩️ SharedStateBus Persistence (New in v1.5.0)

Project Nexus introduces the **SharedStateBus**, allowing runtimes to persist and share variables across different execution steps.

Instead of relying solely on files or environment variables, runtimes can now synchronize state via a high-speed in-process bus. This enables complex multi-step workflows where a Python script can set a state that a subsequent JavaScript script or Bash command can immediately consume.

**Nexus Snapshot Pattern:**

- Use `ag-snapshot` to capture the current state bus and environment.
- Any runtime can `publish` or `subscribe` to events via the singleton bus instance.

# Agent Runtime

> Documentation coming in v5.0.

## Overview

The Agent Runtime provides the RunLoop execution engine that powers autonomous AI agent workflows in ag-bash. It handles tool-call routing, turn budgeting, parallel execution, and graceful shutdown.

## Architecture

```
LLM Provider → RunLoop → Tool Router → Bash Interpreter
                  ↓
            Budget Manager (turns, tokens, wall-clock)
                  ↓
            Result Aggregator → Agent Response
```

## Quick Start

```typescript
import { Bash } from "@ag-bash/bash";
import { RunLoop } from "@ag-bash/bash/agent-runtime";

const bash = new Bash({ runtimes: { python: true } });
const loop = new RunLoop(bash, {
  provider: myLLMProvider,
  budget: { maxTurns: 10, maxTokens: 50000 },
});

const result = await loop.run("Set up a Python project with pytest");
console.log(result.turns, result.totalTokens);
```

## Configuration

See the full [Agent Runtime guide](../agent-runtime.md) for detailed configuration options including budget management, parallel tool execution, and custom LLM provider integration.

# Agent Runtime (RunLoop)

The Agent Runtime provides autonomous execution capabilities for AI agents using ag-bash.

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

### BudgetConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxTurns` | `number` | `25` | Maximum LLM turns before stopping |
| `maxTokens` | `number` | `100000` | Token budget across all turns |
| `maxWallClock` | `number` | `300000` | Wall-clock timeout in ms |

### LLMProvider Interface

Implement this to connect any LLM:

```typescript
interface LLMProvider {
  generate(messages: Message[], tools: ToolSchema[]): Promise<LLMResponse>;
}
```

The `LLMResponse` must include either a `content` string (final answer) or a `toolCalls` array for the RunLoop to dispatch.

### Tool Registration

Tools are automatically registered from the Bash command registry. You can also add custom tools:

```typescript
const loop = new RunLoop(bash, {
  provider: myLLMProvider,
  budget: { maxTurns: 10 },
  additionalTools: [
    {
      name: "search_docs",
      description: "Search project documentation",
      schema: { query: { type: "string" } },
      handler: async (args) => searchDocs(args.query),
    },
  ],
});
```

## Parallel Tool Execution (v5.0)

When the LLM returns multiple tool calls, read-only tools execute in parallel via `Promise.all`. Write tools (`bash`, `run_command`) execute sequentially to preserve state ordering.

### How it works

1. The RunLoop receives a batch of tool calls from the LLM.
2. Each tool is checked for its `readOnlyHint` annotation.
3. Read-only tools (e.g., `ag-grep`, `ag-find-files`, `cat`) are dispatched in parallel.
4. Write tools (e.g., `ag-edit`, `bash`) execute sequentially after parallel reads complete.
5. All results are aggregated and sent back to the LLM in the next turn.

### Performance impact

For typical agent workflows with mixed read/write operations, parallel execution reduces wall-clock time by 30-50% compared to sequential dispatch.

## Lifecycle Events

The RunLoop emits events you can subscribe to for observability:

```typescript
loop.on("turn:start", ({ turnNumber, messages }) => {
  console.log(`Turn ${turnNumber} starting`);
});

loop.on("turn:end", ({ turnNumber, tokenUsage, toolCalls }) => {
  console.log(`Turn ${turnNumber}: ${toolCalls.length} tools, ${tokenUsage} tokens`);
});

loop.on("budget:warning", ({ resource, used, max }) => {
  console.warn(`Budget warning: ${resource} at ${used}/${max}`);
});
```

## Error Handling

The RunLoop handles errors gracefully:

- **Tool execution errors**: Captured and sent back to the LLM as error observations for self-correction.
- **Budget exhaustion**: Returns partial results with a `budgetExhausted` flag.
- **LLM provider errors**: Retried up to 3 times with exponential backoff before failing.

## Integration with MCP

When the MCP server is active, the RunLoop's tools are automatically exposed as MCP tool definitions with proper annotations:

```typescript
// Tools exposed via MCP include annotations
{
  name: "bash",
  annotations: {
    destructiveHint: true,
    readOnlyHint: false,
  }
}
```

See [MCP Orchestration](./registry/mcp_orchestration.md) for details on multi-agent coordination.

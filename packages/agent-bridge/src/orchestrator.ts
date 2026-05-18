import { type Bash, InterpreterState } from "@ag-bash/bash";
import type { AgentAdapter } from "./adapters.js";
import {
  formatForTerminal,
  type TerminalWriter,
  type UIMessage,
} from "./index.js";

export interface OrchestratorOptions {
  bash: Bash;
  adapter: AgentAdapter;
  writer: TerminalWriter;
  maxToolOutputLines?: number;
}

/**
 * AgentOrchestrator coordinates multi-agent workflows and manages execution state.
 * It uses the Bash snapshot engine to allow agent branching and rollbacks.
 */
export class AgentOrchestrator {
  private messages: UIMessage[] = [];
  private snapshots: Map<string, any> = new Map();
  private messageIdCounter = 0;

  constructor(private options: OrchestratorOptions) {}

  /**
   * Run a prompt through the orchestrator
   */
  async run(prompt: string) {
    const { writer, adapter, bash, maxToolOutputLines = 20 } = this.options;

    // 1. Add user message
    const userMsgId = `msg-${++this.messageIdCounter}`;
    this.messages.push({
      id: userMsgId,
      role: "user",
      parts: [{ type: "text", text: prompt }],
    });

    // 2. Prepare for streaming
    let fullText = "";
    let lineBuffer = "";
    const toolCallsMap = new Map<
      string,
      { toolName: string; args: unknown; result?: string }
    >();

    let thinkingTimeout: ReturnType<typeof setTimeout> | null = null;
    let showingThinking = false;

    const showThinking = () => {
      if (!showingThinking) {
        showingThinking = true;
        writer.write("\x1b[2mThinking...\x1b[0m");
      }
    };

    const clearThinking = (restart = true) => {
      if (showingThinking) {
        writer.write("\r\x1b[K");
        showingThinking = false;
      }
      if (thinkingTimeout) {
        clearTimeout(thinkingTimeout);
        thinkingTimeout = null;
      }
      if (restart) {
        thinkingTimeout = setTimeout(showThinking, 500);
      }
    };

    const resetThinkingTimer = () => {
      if (thinkingTimeout) clearTimeout(thinkingTimeout);
      if (!showingThinking) {
        thinkingTimeout = setTimeout(showThinking, 500);
      }
    };

    const formatToolResult = (tc: {
      toolName: string;
      args: unknown;
      result?: string;
    }) => {
      if (!tc.result) return;
      let displayResult = tc.result;
      try {
        const parsed = JSON.parse(tc.result);
        if (tc.toolName === "bash") {
          if (parsed.stderr && parsed.stderr.trim())
            displayResult = `stderr: ${parsed.stderr}`;
          else if (parsed.stdout !== undefined) displayResult = parsed.stdout;

          if (parsed.observations && parsed.observations.length > 0) {
            let obsText = "";
            for (const obs of parsed.observations) {
              obsText += `\n💡 ${obs.message}`;
              if (obs.suggestions && obs.suggestions.length > 0) {
                obsText += `\n   Suggestion: ${obs.suggestions.join(", ")}`;
              }
            }
            displayResult += obsText;
          }
        } else if (tc.toolName === "read_file") {
          if (parsed.error) {
            displayResult = `Error: ${parsed.error}`;
            if (parsed.suggestions) {
              displayResult += `\nDid you mean:\n - ${parsed.suggestions.join("\n - ")}`;
            }
          } else {
            displayResult = parsed.content;
          }
        } else if (tc.toolName === "write_file") {
          displayResult = parsed.success
            ? "File written successfully."
            : `Error: ${parsed.error}`;
        } else if (tc.toolName === "list_files") {
          if (parsed.error) {
            displayResult = `Error: ${parsed.error}`;
          } else if (parsed.files) {
            displayResult = parsed.files.join("\n");
          } else {
            displayResult = parsed.output;
          }
        } else if (tc.toolName === "edit_file") {
          if (parsed.error) {
            displayResult = `Error: ${parsed.error}\nFailed Patch: ${parsed.failedPatch}\n${parsed.context || ""}`;
          } else {
            displayResult = parsed.message || "File updated successfully.";
          }
        } else if (tc.toolName === "analyze_code") {
          if (parsed.error) {
            displayResult = `Error: ${parsed.error}\n${parsed.parseError || ""}`;
          } else {
            displayResult = `Type: ${parsed.type}\nLines: ${parsed.lineCount}\nBytes: ${parsed.byteCount}`;
            if (parsed.symbols && parsed.symbols.length > 0) {
              displayResult += `\n\nSymbols found:\n`;
              for (const sym of parsed.symbols) {
                displayResult += ` - [${sym.type}] ${sym.name} (Line ${sym.line})\n`;
              }
            }
          }
        } else if (tc.toolName === "run_command") {
          if (parsed.error) {
            displayResult = `Error: ${parsed.error}`;
          } else {
            displayResult = parsed.stdout || "";
            if (parsed.stderr) displayResult += `\nstderr: ${parsed.stderr}`;
            if (parsed.exitCode !== 0)
              displayResult += `\nExit Code: ${parsed.exitCode}`;
          }
        } else if (tc.toolName === "find_symbols") {
          if (parsed.error) {
            displayResult = `Error: ${parsed.error}`;
          } else if (parsed.results && parsed.results.length > 0) {
            displayResult = `Found ${parsed.results.length} symbols:\n`;
            for (const sym of parsed.results) {
              displayResult += ` - [${sym.type}] ${sym.name} in ${sym.path}:${sym.line}\n`;
            }
          } else {
            displayResult = "No symbols found matching the query.";
          }
        } else if (tc.toolName === "explain_command") {
          if (parsed.error) {
            displayResult = `Error: ${parsed.error}`;
          } else {
            displayResult = `Explanation:\n${parsed.explanation}`;
          }
        } else if (tc.toolName === "find_files") {
          if (parsed.error) {
            displayResult = `Error: ${parsed.error}`;
          } else if (parsed.results && parsed.results.length > 0) {
            displayResult =
              `Found ${parsed.results.length} files:\n` +
              parsed.results.join("\n");
          } else {
            displayResult = "No files found matching the pattern.";
          }
        } else if (tc.toolName === "grep_search") {
          if (parsed.error) {
            displayResult = `Error: ${parsed.error}`;
          } else if (parsed.results && parsed.results.length > 0) {
            displayResult = `Found ${parsed.results.length} matches:\n`;
            for (const res of parsed.results) {
              displayResult += ` - ${res.path}:${res.line}: ${res.content}\n`;
            }
          } else {
            displayResult = "No matches found.";
          }
        } else if (tc.toolName === "check_environment") {
          if (parsed.error) {
            displayResult = `Error: ${parsed.error}`;
          } else {
            displayResult =
              `Environment: ${parsed.version}\n` +
              `CWD: ${parsed.cwd}\n` +
              `Uptime: ${Math.floor(parsed.usage.uptime / 1000)}s\n` +
              `Commands: ${parsed.usage.commandCount}\n` +
              `Limits: CPU=${parsed.limits.cpuTimeout}ms, Depth=${parsed.limits.maxCallDepth}\n` +
              `Capabilities: ${parsed.capabilities.join(", ")}`;
          }
        } else if (tc.toolName === "run_js" || tc.toolName === "run_python") {
          displayResult = parsed.stdout || "";
          if (parsed.stderr) displayResult += `\nstderr: ${parsed.stderr}`;
          if (parsed.exitCode !== 0)
            displayResult += `\nExit Code: ${parsed.exitCode}`;
        } else if (tc.toolName === "query_json") {
          displayResult = parsed.stdout || "";
          if (parsed.stderr) displayResult += `\nstderr: ${parsed.stderr}`;
        } else if (tc.toolName === "diff_files") {
          displayResult = parsed.diff || "No differences found.";
          if (parsed.stderr) displayResult += `\nstderr: ${parsed.stderr}`;
        } else if (tc.toolName === "help_builtin") {
          displayResult = parsed.help || "";
          if (parsed.stderr) displayResult += `\nstderr: ${parsed.stderr}`;
        } else if (tc.toolName === "list_todos") {
          if (parsed.todos && Array.isArray(parsed.todos)) {
            if (parsed.todos.length === 0) {
              displayResult = "Todo list is empty.";
            } else {
              displayResult =
                "📋 Todo List:\n" +
                parsed.todos
                  .map((t: any) => {
                    const icon =
                      t.status === "done"
                        ? "✅"
                        : t.status === "doing"
                          ? "⏳"
                          : "⭕";
                    return `${icon} [#${t.id}] ${t.task}`;
                  })
                  .join("\n");
            }
          }
        } else if (tc.toolName === "search_symbols") {
          if (parsed.results && Array.isArray(parsed.results)) {
            if (parsed.results.length === 0) {
              displayResult = "No symbols found matching the query.";
            } else {
              displayResult =
                `🔍 Found ${parsed.results.length} symbols:\n` +
                parsed.results
                  .map(
                    (s: any) =>
                      ` - [${s.type}] ${s.name} (${s.path}:${s.line})`,
                  )
                  .join("\n");
            }
          }
        }
      } catch {}

      if (displayResult && displayResult.trim()) {
        const resultLines = displayResult.split("\n").filter((l) => l.trim());
        const linesToShow = resultLines.slice(0, maxToolOutputLines);
        let output = linesToShow
          .map((line) => `\x1b[2m${line}\x1b[0m`)
          .join("\n");
        if (resultLines.length > maxToolOutputLines) {
          output += `\n\x1b[2m... (${resultLines.length - maxToolOutputLines} more lines)\x1b[0m`;
        }
        writer.write(formatForTerminal(output) + "\r\n");
      }
    };

    resetThinkingTimer();

    try {
      // 3. Stream from adapter
      for await (const chunk of adapter.run(this.messages)) {
        if (chunk.type === "text-delta" && chunk.delta) {
          fullText += chunk.delta;
          lineBuffer += chunk.delta;
          const lastNewline = lineBuffer.lastIndexOf("\n");
          if (lastNewline !== -1) {
            clearThinking();
            writer.write(
              formatForTerminal(lineBuffer.slice(0, lastNewline + 1)),
            );
            lineBuffer = lineBuffer.slice(lastNewline + 1);
          } else {
            resetThinkingTimer();
          }
        } else if (chunk.type === "tool-input-available" && chunk.toolCallId) {
          clearThinking();
          if (fullText && !fullText.endsWith("\n")) {
            writer.write("\r\n");
            fullText += "\n";
          }

          if (chunk.toolName === "bash" && chunk.input.command) {
            const lines = String(chunk.input.command).split("\n");
            writer.write(`\x1b[36m$ ${lines[0]}\x1b[0m\r\n`);
            for (let i = 1; i < lines.length; i++)
              writer.write(`\x1b[36m${lines[i]}\x1b[0m\r\n`);
          } else if (chunk.toolName === "snapshot") {
            const snap = await bash.snapshot();
            const snapId = `snap-${this.snapshots.size}`;
            this.snapshots.set(snapId, snap);
            writer.write(
              `\x1b[35m[Orchestrator] Created snapshot ${snapId}\x1b[0m\r\n`,
            );
          } else if (chunk.toolName === "restore" && chunk.input.snapshotId) {
            const snap = this.snapshots.get(chunk.input.snapshotId);
            if (snap) {
              await bash.restore(snap);
              writer.write(
                `\x1b[35m[Orchestrator] Restored to ${chunk.input.snapshotId}\x1b[0m\r\n`,
              );
            }
          } else if (chunk.toolName === "index_workspace") {
            writer.write(`\x1b[36m🔨 Building workspace index...\x1b[0m\r\n`);
          } else {
            writer.write(`\x1b[36m[${chunk.toolName}]\x1b[0m\r\n`);
          }
          toolCallsMap.set(chunk.toolCallId, {
            toolName: chunk.toolName,
            args: chunk.input,
          });
        } else if (chunk.type === "tool-output-available" && chunk.toolCallId) {
          const existing = toolCallsMap.get(chunk.toolCallId);
          const resultStr =
            typeof chunk.output === "string"
              ? chunk.output
              : JSON.stringify(chunk.output, null, 2);
          const tc = {
            toolName: existing?.toolName || "tool",
            args: existing?.args || {},
            result: resultStr,
          };
          formatToolResult(tc);
          if (existing) existing.result = resultStr;

          // Check for interruption (HITL)
          if (
            chunk.output &&
            typeof chunk.output === "object" &&
            (chunk.output as any).interrupted
          ) {
            const hitl = chunk.output as any;
            writer.write(
              `\r\n\x1b[33m💡 HITL Prompt: ${hitl.question}\x1b[0m\r\n`,
            );
            // We break the loop to allow the caller to handle the interaction
            return {
              type: "interrupted",
              question: hitl.question,
              toolCallId: chunk.toolCallId,
            };
          }
        } else if (chunk.type === "text-end") {
          clearThinking();
          if (lineBuffer) {
            writer.write(formatForTerminal(lineBuffer));
            lineBuffer = "";
          }
          writer.write("\r\n");
        }
      }

      clearThinking(false);
      if (lineBuffer) writer.write(formatForTerminal(lineBuffer + "\r\n"));

      this.messages.push({
        id: `msg-${++this.messageIdCounter}`,
        role: "assistant",
        parts: [{ type: "text", text: fullText }],
      });
    } catch (error) {
      writer.write(`\x1b[31mOrchestration Error: ${error}\x1b[0m\r\n`);
    }
  }

  getMessages() {
    return [...this.messages];
  }
  reset() {
    this.messages = [];
    this.snapshots.clear();
  }
}

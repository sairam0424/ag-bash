import { defineCommand } from "@ag-bash/bash";

/**
 * Terminal UI Message format
 */
export type UIMessage = {
  id: string;
  role: "user" | "assistant";
  parts: Array<{ type: "text"; text: string }>;
};

/**
 * Interface for terminal writing (compatible with xterm.js)
 */
export type TerminalWriter = {
  write: (data: string) => void;
};

/**
 * Configuration for the agent bridge
 */
export interface AgentBridgeOptions {
  apiEndpoint?: string;
  maxToolOutputLines?: number;
  onStateUpdate?: (messages: UIMessage[]) => void;
}

/**
 * Sanitizes local paths and Node.js internals from terminal error messages.
 */
export function sanitizeTerminalError(message: string): string {
  return message
    .replace(/\n\s+at\s.*/g, "")
    .replace(/node:internal\/[^\s'",)}\]:]+/g, "<internal>")
    .replace(
      /(?:\/(?:Users|home|private|var|opt|Library|System|usr|etc|tmp|nix|snap))\b[^\s'",)}\]:]*/g,
      "<path>",
    )
    .replace(/[A-Z]:\\[^\s'",)}\]:]+/g, "<path>");
}

/**
 * Formats text for terminal display: normalizes newlines and converts tabs to spaces.
 */
export function formatForTerminal(text: string): string {
  return text.replace(/\t/g, "  ").replace(/\r?\n/g, "\r\n");
}

/**
 * Creates an agent executor that handles streaming AI responses and tool outputs
 * in a terminal environment.
 */
export function createAgentBridge(term: TerminalWriter, options: AgentBridgeOptions = {}) {
  const { 
    apiEndpoint = "/api/agent", 
    maxToolOutputLines = 20,
    onStateUpdate 
  } = options;

  const agentMessages: UIMessage[] = [];
  let messageIdCounter = 0;

  async function executeAgentPrompt(prompt: string) {
    if (!prompt) {
      return { stdout: "", stderr: "Error: Empty prompt\n", exitCode: 1 };
    }

    // Add user message to history
    agentMessages.push({
      id: `msg-${++messageIdCounter}`,
      role: "user",
      parts: [{ type: "text", text: prompt }],
    });
    onStateUpdate?.([...agentMessages]);

    try {
      const response = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: agentMessages }),
      });

      if (!response.ok) {
        agentMessages.pop();
        onStateUpdate?.([...agentMessages]);
        return {
          stdout: "",
          stderr: `Error: ${response.status}\n`,
          exitCode: 1,
        };
      }

      const reader = response.body?.getReader();
      if (!reader) {
        agentMessages.pop();
        onStateUpdate?.([...agentMessages]);
        return { stdout: "", stderr: "Error: No response body\n", exitCode: 1 };
      }

      let lineBuffer = "";
      let fullText = "";
      const toolCallsMap = new Map<string, { toolName: string; args: unknown; result?: string }>();
      const decoder = new TextDecoder();
      let buffer = "";
      let isStreaming = false;

      let thinkingTimeout: ReturnType<typeof setTimeout> | null = null;
      let showingThinking = false;

      const showThinking = () => {
        if (!showingThinking) {
          showingThinking = true;
          term.write("\x1b[2mThinking...\x1b[0m");
        }
      };

      const clearThinking = (restart = true) => {
        if (showingThinking) {
          term.write("\r\x1b[K");
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
        if (thinkingTimeout) {
          clearTimeout(thinkingTimeout);
        }
        if (!showingThinking) {
          thinkingTimeout = setTimeout(showThinking, 500);
        }
      };

      resetThinkingTimer();

      const formatToolResult = (tc: { toolName: string; args: unknown; result?: string }) => {
        if (!tc.result) return;
        let displayResult = tc.result;
        try {
          const parsed = JSON.parse(tc.result);
          if (tc.toolName === "bash") {
            if (parsed.stderr && parsed.stderr.trim()) {
              displayResult = `stderr: ${parsed.stderr}`;
            } else if (parsed.stdout !== undefined) {
              displayResult = parsed.stdout;
            }
          } else if (tc.toolName === "readFile") {
            if (parsed.content !== undefined) {
              displayResult = parsed.content;
            }
          }
        } catch {
          // Keep original
        }

        if (displayResult && displayResult.trim()) {
          const resultLines = displayResult.split("\n").filter((l: string) => l.trim());
          const linesToShow = resultLines.slice(0, maxToolOutputLines);
          let output = linesToShow.map((line) => `\x1b[2m${line}\x1b[0m`).join("\n");
          if (resultLines.length > maxToolOutputLines) {
            output += `\n\x1b[2m... (${resultLines.length - maxToolOutputLines} more lines)\x1b[0m`;
          }
          term.write(formatForTerminal(output) + "\r\n");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || !trimmedLine.startsWith("data:")) continue;

          const jsonStr = trimmedLine.slice(5).trim();
          if (jsonStr === "[DONE]") continue;

          try {
            const data = JSON.parse(jsonStr);

            if (data.type === "text-delta" && data.delta) {
              fullText += data.delta;
              lineBuffer += data.delta;
              const lastNewline = lineBuffer.lastIndexOf("\n");
              if (lastNewline !== -1) {
                clearThinking();
                const completeLines = lineBuffer.slice(0, lastNewline + 1);
                lineBuffer = lineBuffer.slice(lastNewline + 1);
                term.write(formatForTerminal(completeLines));
              } else {
                resetThinkingTimer();
              }
            } else if (data.type === "text-end") {
              clearThinking();
              if (lineBuffer) {
                term.write(formatForTerminal(lineBuffer));
                lineBuffer = "";
              }
              term.write("\r\n");
            } else if (data.type === "tool-input-available" && data.toolCallId) {
              clearThinking();
              if (fullText && !fullText.endsWith("\n")) {
                term.write("\r\n");
                fullText += "\n";
              }
              const args = data.input as Record<string, unknown>;
              if (data.toolName === "bash" && args.command) {
                const cmd = String(args.command).replace(/\t/g, "  ");
                const lines = cmd.split("\n");
                term.write(`\x1b[36m$ ${lines[0]}\x1b[0m\r\n`);
                for (let i = 1; i < lines.length; i++) {
                  term.write(`\x1b[36m${lines[i]}\x1b[0m\r\n`);
                }
              } else {
                term.write(`\x1b[36m[${data.toolName}]\x1b[0m\r\n`);
              }
              toolCallsMap.set(data.toolCallId, { toolName: data.toolName, args: data.input });
            } else if (data.type === "tool-output-available" && data.toolCallId) {
              const existing = toolCallsMap.get(data.toolCallId);
              const result = data.output;
              const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
              const tc = {
                toolName: existing?.toolName || "tool",
                args: existing?.args || Object.create(null),
                result: resultStr,
              };
              formatToolResult(tc);
              if (existing) existing.result = resultStr;
              else toolCallsMap.set(data.toolCallId, tc);
            } else if (data.type === "error") {
              const errorMsg = data.error || data.message || "Unknown error";
              term.write(`\x1b[31mError: ${formatForTerminal(String(errorMsg))}\x1b[0m\r\n`);
            }
          } catch (e) {
             // Silence parse errors for streaming deltas
          }
        }
      }

      clearThinking(false);
      if (lineBuffer) {
        term.write(formatForTerminal(lineBuffer));
        term.write("\r\n");
      }

      if (fullText) {
        agentMessages.push({
          id: `msg-${++messageIdCounter}`,
          role: "assistant",
          parts: [{ type: "text", text: fullText }],
        });
        onStateUpdate?.([...agentMessages]);
      }

      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (error) {
      const message = sanitizeTerminalError(error instanceof Error ? error.message : "Unknown error");
      agentMessages.pop();
      onStateUpdate?.([...agentMessages]);
      return { stdout: "", stderr: `Error: ${message}\n`, exitCode: 1 };
    }
  }

  const agentCmd = defineCommand("agent", async (args: string[]) => {
    const prompt = args.join(" ");
    if (!prompt) {
      return {
        stdout: "",
        stderr: "Usage: agent <message>\nExample: agent how do I use custom commands?\n",
        exitCode: 1,
      };
    }

    if (prompt.toLowerCase() === "reset") {
      agentMessages.length = 0;
      onStateUpdate?.([]);
      return { stdout: "Agent conversation reset.\n", stderr: "", exitCode: 0 };
    }

    return executeAgentPrompt(prompt);
  });

  return { agentCmd, executeAgentPrompt, agentMessages };
}

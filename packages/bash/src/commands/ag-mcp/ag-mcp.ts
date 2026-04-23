/**
 * ag-mcp command - Model Context Protocol integration
 * 
 * Subcommands:
 * - connect <stdio|http> <config> : Connect to an MCP server
 * - list : List connected servers and tools
 * - call <server_id> <tool_name> [args_json] : Call an MCP tool
 * - disconnect <server_id> : Close a connection
 */

import { Command, CommandContext, ExecResult } from "../../types.js";
import { McpClient } from "../../services/McpClient.js";

export const agMcp: Command = {
  name: "ag-mcp",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    const client = McpClient.getInstance();
    const subcommand = args[0];

    if (!subcommand) {
      return {
        stdout: "",
        stderr: "Usage: ag-mcp <connect|list|call|disconnect> [args]\n",
        exitCode: 1
      };
    }

    switch (subcommand) {
      case "list": {
        const conns = client.listConnections();
        if (conns.length === 0) {
          return { stdout: "No active MCP connections.\n", stderr: "", exitCode: 0 };
        }
        let output = "Active MCP Connections:\n";
        for (const conn of conns) {
          output += `- ${conn.id} [${conn.type}] status: ${conn.status}\n`;
          for (const tool of conn.tools) {
            output += `    - ${tool.name}: ${tool.description || "(no description)"}\n`;
          }
        }
        return { stdout: output, stderr: "", exitCode: 0 };
      }

      case "connect": {
        const type = args[1];
        const id = args[2];
        const target = args[3];

        if (!type || !id || !target) {
          return {
            stdout: "",
            stderr: "Usage: ag-mcp connect <stdio|http> <id> <command|url> [args...]\n",
            exitCode: 1
          };
        }

        try {
          if (type === "stdio") {
            const cmdArgs = args.slice(4);
            const conn = await client.connectStdio(id, target, cmdArgs, ctx);
            ctx.bash?.toolbox.registerMcpTools(id, conn.tools);
          } else if (type === "http") {
            const conn = await client.connectHttp(id, target, ctx.bash);
            ctx.bash?.toolbox.registerMcpTools(id, conn.tools);
          } else {
            return { stdout: "", stderr: `Unknown connection type: ${type}\n`, exitCode: 1 };
          }
          return { stdout: `Successfully connected to MCP server: ${id}\n`, stderr: "", exitCode: 0 };
        } catch (e: any) {
          return { stdout: "", stderr: `Connection failed: ${e.message}\n`, exitCode: 1 };
        }
      }

      case "call": {
        const id = args[1];
        const toolName = args[2];
        const argsJson = args[3] || "{}";

        if (!id || !toolName) {
          return {
            stdout: "",
            stderr: "Usage: ag-mcp call <id> <tool_name> [args_json]\n",
            exitCode: 1
          };
        }

        try {
          const parsedArgs = JSON.parse(argsJson);
          const result = await client.callTool(id, toolName, parsedArgs, ctx.bash);
          return { stdout: JSON.stringify(result, null, 2) + "\n", stderr: "", exitCode: 0 };
        } catch (e: any) {
          return { stdout: "", stderr: `Tool call failed: ${e.message}\n`, exitCode: 1 };
        }
      }

      case "disconnect": {
        const id = args[1];
        if (!id) {
          return { stdout: "", stderr: "Usage: ag-mcp disconnect <id>\n", exitCode: 1 };
        }
        client.disconnect(id);
        return { stdout: `Disconnected from ${id}\n`, stderr: "", exitCode: 0 };
      }

      default:
        return { stdout: "", stderr: `Unknown subcommand: ${subcommand}\n`, exitCode: 1 };
    }
  }
};

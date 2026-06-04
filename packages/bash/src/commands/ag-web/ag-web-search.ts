import { z } from "zod";
import type { ToolboxTool } from "../../agentic/Tool.js";
import type { Bash } from "../../Bash.js";
import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";

interface WebSearchArgs {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

const webSearchParameters: z.ZodType<WebSearchArgs> = z.object({
  query: z.string().describe("The search query to execute."),
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe("Restrict results to these domains."),
  blocked_domains: z
    .array(z.string())
    .optional()
    .describe("Exclude results from these domains."),
});

/**
 * ag-web-search: Search the web for information.
 *
 * Note: This implementation is a shell that delegates to the underlying fetch
 * or an external search API if configured.
 */
export const WebSearchTool: ToolboxTool<WebSearchArgs, string> = {
  name: "ag_web_search",
  description:
    "Search the web for current information, documentation, and answers.",
  parameters: webSearchParameters,
  isReadOnly: true,
  isDestructive: false,
  checkPermissions: async (_bash: Bash, _args: WebSearchArgs) => ({
    behavior: "allow",
  }),
  validateInput: async (_args: unknown) => ({ result: true }),
  execute: async (bash: Bash, { query }: WebSearchArgs) => {
    const env = bash.env;
    const serperKey = env.SERPER_API_KEY;
    const tavilyKey = env.TAVILY_API_KEY;

    if (serperKey) {
      try {
        const response = await bash.exec(
          `curl -H "X-API-KEY: ${serperKey}" -H "Content-Type: application/json" -d '{"q": "${query}"}' https://google.serper.dev/search`,
        );
        return response.stdout;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return `Serper search failed: ${sanitizeErrorMessage(message)}`;
      }
    }

    if (tavilyKey) {
      try {
        const response = await bash.exec(
          `curl -H "Content-Type: application/json" -d '{"api_key": "${tavilyKey}", "query": "${query}"}' https://api.tavily.com/search`,
        );
        return response.stdout;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return `Tavily search failed: ${sanitizeErrorMessage(message)}`;
      }
    }

    // Fallback to informative message
    return `Searching for: ${query}\n\nNo search API keys (SERPER_API_KEY or TAVILY_API_KEY) detected. \n\nResults would typically include URLs and snippets from the web. Use ag_web_fetch to retrieve specific page content if you already have a URL.`;
  },
};

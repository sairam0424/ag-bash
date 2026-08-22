import { z } from "zod";
import { buildTool, type ToolboxTool } from "../../agentic/Tool.js";
import type { Bash } from "../../Bash.js";
import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import { shellJoinArgs } from "../../helpers/shell-quote.js";

const SERPER_ENDPOINT = "https://google.serper.dev/search";
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const JSON_CONTENT_TYPE = "Content-Type: application/json";

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
export const WebSearchTool: ToolboxTool<WebSearchArgs, string> = buildTool<
  WebSearchArgs,
  string
>({
  name: "ag_web_search",
  description:
    "Search the web for current information, documentation, and answers.",
  parameters: webSearchParameters,
  isReadOnly: true,
  isDestructive: false,
  checkPermissions: async (_bash: Bash, _args: WebSearchArgs) => ({
    behavior: "allow",
  }),
  // validateInput is intentionally omitted: buildTool supplies a zod
  // safeParse gate derived from `parameters`. The previous explicit
  // `async () => ({ result: true })` stub silently disabled that gate.
  execute: async (bash: Bash, { query }: WebSearchArgs) => {
    const env = bash.env;
    const serperKey = env.SERPER_API_KEY;
    const tavilyKey = env.TAVILY_API_KEY;

    if (serperKey) {
      try {
        // `query` is attacker-controlled (model or user text), so every token
        // is single-quoted via shellJoinArgs. The API key is passed as a shell
        // parameter expansion rather than an interpolated literal, keeping it
        // out of the command string the interpreter parses, caches and traces.
        const response = await bash.exec(
          `curl -H "X-API-KEY: $SERPER_API_KEY" ${shellJoinArgs([
            "-H",
            JSON_CONTENT_TYPE,
            "-d",
            JSON.stringify({ q: query }),
            SERPER_ENDPOINT,
          ])}`,
        );
        return response.stdout;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return `Serper search failed: ${sanitizeErrorMessage(message)}`;
      }
    }

    if (tavilyKey) {
      try {
        // Tavily carries its credential inside the JSON body, so it cannot be
        // moved to a shell expansion the way the Serper header can; the body
        // token is still fully quoted, which is what closes the injection.
        const response = await bash.exec(
          shellJoinArgs([
            "curl",
            "-H",
            JSON_CONTENT_TYPE,
            "-d",
            JSON.stringify({ api_key: tavilyKey, query }),
            TAVILY_ENDPOINT,
          ]),
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
});

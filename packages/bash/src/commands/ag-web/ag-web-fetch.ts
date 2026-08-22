import { z } from "zod";
import { buildTool, type ToolboxTool } from "../../agentic/Tool.js";
import type { Bash } from "../../Bash.js";
import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import { shellJoinArgs } from "../../helpers/shell-quote.js";
import { WebCache } from "../../network/WebCache.js";

const cache = new WebCache();

interface WebFetchArgs {
  url: string;
  noCache?: boolean;
}

const webFetchParameters: z.ZodType<WebFetchArgs> = z.object({
  url: z.string().describe("The URL of the page to fetch."),
  noCache: z
    .boolean()
    .optional()
    .describe("If true, bypass the cache and fetch fresh content."),
});

/**
 * ag-web-fetch: Fetch content from a URL and convert to markdown.
 * Includes response caching (15min TTL) and redirect following.
 */
export const WebFetchTool: ToolboxTool<WebFetchArgs, string> = buildTool<
  WebFetchArgs,
  string
>({
  name: "ag_web_fetch",
  description:
    "Fetch the content of a web page and convert it to clean markdown. Results are cached for 15 minutes.",
  parameters: webFetchParameters,
  isReadOnly: true,
  isDestructive: false,
  checkPermissions: async (_bash: Bash, _args: WebFetchArgs) => ({
    behavior: "allow",
  }),
  // validateInput is intentionally omitted: buildTool supplies a zod
  // safeParse gate derived from `parameters`. The previous explicit
  // `async () => ({ result: true })` stub silently disabled that gate.
  execute: async (bash: Bash, { url, noCache }: WebFetchArgs) => {
    try {
      if (!noCache) {
        const cached = cache.get(url);
        if (cached) {
          return `[cached] ${cached.content}`;
        }
      }

      const fetchUrl = url.replace(/^http:\/\//, "https://");

      // `url` is attacker-controlled (model or user text). Double quotes do
      // not suppress $(...) or backticks, so the URL must be a fully quoted
      // literal token rather than interpolated into the command string.
      const fetchResult = await bash.exec(
        shellJoinArgs(["curl", "-sL", fetchUrl]),
      );
      if (fetchResult.exitCode !== 0) {
        return `Failed to fetch ${fetchUrl}: ${fetchResult.stderr}`;
      }

      const html = fetchResult.stdout;

      // The fetched body is remote-controlled too, so it goes through the same
      // canonical quoting helper instead of a hand-rolled escape.
      const convertResult = await bash.exec(
        `${shellJoinArgs(["echo", html])} | html-to-markdown`,
      );

      const markdown =
        convertResult.stdout ||
        "Fetched content, but conversion to markdown was empty.";

      cache.put(url, markdown, {
        contentType: "text/markdown",
        statusCode: 200,
      });

      return markdown;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Fetch failed: ${sanitizeErrorMessage(message)}`;
    }
  },
});

import { z } from "zod";
import type { ToolboxTool } from "../../agentic/Tool.js";
import type { Bash } from "../../Bash.js";
import { WebCache } from "../../network/WebCache.js";

const cache = new WebCache();

/**
 * ag-web-fetch: Fetch content from a URL and convert to markdown.
 * Includes response caching (15min TTL) and redirect following.
 */
export const WebFetchTool: ToolboxTool = {
  name: "ag_web_fetch",
  description:
    "Fetch the content of a web page and convert it to clean markdown. Results are cached for 15 minutes.",
  parameters: z.object({
    url: z.string().describe("The URL of the page to fetch."),
    noCache: z
      .boolean()
      .optional()
      .describe("If true, bypass the cache and fetch fresh content."),
  }),
  isReadOnly: true,
  isDestructive: false,
  checkPermissions: async (_bash: Bash, _args: any) => ({ behavior: "allow" }),
  validateInput: async (_args: any) => ({ result: true }),
  execute: async (
    bash: Bash,
    { url, noCache }: { url: string; noCache?: boolean },
  ) => {
    try {
      if (!noCache) {
        const cached = cache.get(url);
        if (cached) {
          return `[cached] ${cached.content}`;
        }
      }

      const fetchUrl = url.replace(/^http:\/\//, "https://");

      const fetchResult = await bash.exec(`curl -sL "${fetchUrl}"`);
      if (fetchResult.exitCode !== 0) {
        return `Failed to fetch ${fetchUrl}: ${fetchResult.stderr}`;
      }

      const html = fetchResult.stdout;

      const convertResult = await bash.exec(
        `echo '${html.replace(/'/g, "'\\''")}' | html-to-markdown`,
      );

      const markdown =
        convertResult.stdout ||
        "Fetched content, but conversion to markdown was empty.";

      cache.put(url, markdown, {
        contentType: "text/markdown",
        statusCode: 200,
      });

      return markdown;
    } catch (error: any) {
      return `Fetch failed: ${error.message}`;
    }
  },
};

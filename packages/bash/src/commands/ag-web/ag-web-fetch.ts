import { z } from "zod";
import type { ToolboxTool } from "../../agentic/BashToolbox.js";
import type { Bash } from "../../Bash.js";

/**
 * ag-web-fetch: Fetch content from a URL and convert to markdown.
 */
export const WebFetchTool: ToolboxTool = {
  name: "ag_web_fetch",
  description:
    "Fetch the content of a web page and convert it to clean markdown.",
  parameters: z.object({
    url: z.string().describe("The URL of the page to fetch."),
  }),
  execute: async (bash: Bash, { url }) => {
    try {
      // Use curl to fetch the content
      const fetchResult = await bash.exec(`curl -L "${url}"`);
      if (fetchResult.exitCode !== 0) {
        return `Failed to fetch ${url}: ${fetchResult.stderr}`;
      }

      const html = fetchResult.stdout;

      // Use the built-in html-to-markdown command if available
      const convertResult = await bash.exec(
        `echo '${html.replace(/'/g, "'\\''")}' | html-to-markdown`,
      );

      return (
        convertResult.stdout ||
        "Fetched content, but conversion to markdown was empty."
      );
    } catch (error: any) {
      return `Fetch failed: ${error.message}`;
    }
  },
};

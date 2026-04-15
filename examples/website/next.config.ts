import type { NextConfig } from "next";

const cspHeader = `
  default-src 'self';
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self';
  connect-src 'self';
  frame-src 'self';
  object-src 'none';
  base-uri 'self';
  form-action 'self';
`
  .replace(/\n/g, " ")
  .trim();

const nextConfig: NextConfig = {
  serverExternalPackages: ["ag-bash"],
  outputFileTracingIncludes: {
    "/api/agent": ["./app/api/agent/_agent-data/**/*"],
    "/api/fs": ["./app/api/agent/_agent-data/**/*"],
  },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: cspHeader },
      ],
    },
  ],
  rewrites: async () => {
    return {
      beforeFiles: [
        {
          source: "/",
          destination: "/md/README.md",
          has: [
            {
              type: "header",
              key: "accept",
              value: "(.*)text/markdown(.*)",
            },
          ],
        },
        {
          source: "/:path*",
          destination: "/md/:path*",
          has: [
            {
              type: "header",
              key: "accept",
              value: "(.*)text/markdown(.*)",
            },
          ],
        },
      ],
    };
  }
};

export default nextConfig;

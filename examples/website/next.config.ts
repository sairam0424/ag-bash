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
  transpilePackages: ["@ag-bash/agent-bridge"],
  serverExternalPackages: ["@ag-bash/bash"],
  // Turbopack disabled for production stability
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
        crypto: false,
        stream: false,
        util: false,
        url: false,
        readline: false,
        child_process: false,
        worker_threads: false,
        module: false,
        dns: false,
        zlib: false,
        'node:fs': false,
        'node:path': false,
        'node:os': false,
        'node:crypto': false,
        'node:url': false,
        'node:worker_threads': false,
        'node:async_hooks': false,
        'node:child_process': false,
        'node:readline': false,
        'node:stream': false,
        'node:util': false,
        'node:zlib': false,
        'node:dns': false,
        '@mongodb-js/zstd': false,
        '@mongodb-js/saslprep': false,
      };
    }
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    return config;
  },
  outputFileTracingIncludes: {
    "/api/agent": ["./public/agent-data/**/*"],
    "/api/fs": ["./public/agent-data/**/*"],
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

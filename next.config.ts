import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Keep the Node-only Casper chain SDK external to the server bundle — it pulls in
  // node-fetch/eventsource/glob and is loaded lazily by the real chain adapter (server-only).
  serverExternalPackages: ["casper-js-sdk"],
  // Ensure the Odra proxy wasm (read via fs by the real chain adapter) is traced into the
  // chain route bundles on Vercel — a payable bet can't attach CSPR without it.
  outputFileTracingIncludes: {
    "/api/chain/**": ["./src/adapters/casper/resources/**"],
  },
};

export default nextConfig;

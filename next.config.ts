import "./src/server/env";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The research folder holds raw captures and its own tooling; keep it out of builds.
  outputFileTracingExcludes: { "*": ["research/**"] },
};

export default nextConfig;

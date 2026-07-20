import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // pnpm workspace root is two levels up from apps/panel; without this,
  // output tracing only looks inside apps/panel and misses hoisted
  // workspace deps when building the Docker image.
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

export default nextConfig;

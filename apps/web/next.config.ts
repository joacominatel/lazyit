import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the production Docker image (infra/docker/web.Dockerfile).
  // The standalone output traces only the node_modules the app actually uses, keeping the
  // runtime image small. Authorized cross-lane DevOps edit — see ADR-0025.
  output: "standalone",
};

export default nextConfig;

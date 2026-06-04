import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the production Docker image (infra/docker/web.Dockerfile).
  // The standalone output traces only the node_modules the app actually uses, keeping the
  // runtime image small. Authorized cross-lane DevOps edit — see ADR-0025.
  output: "standalone",
};

// i18n (next-intl, cookie-mode — ADR-0051). The plugin points at the request config that
// reads the locale from the NEXT_LOCALE cookie; the default path is `./i18n/request.ts`, so
// no explicit argument is needed.
const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);

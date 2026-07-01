import { useQuery } from "@tanstack/react-query";
import { getInstanceVersion } from "../endpoints/instance";

/**
 * Query-key factory for the `/instance` identity surface (ADR-0083, ADR-0020 data layer).
 * A single key — the version read is the whole surface (the consumption half is ADR-0084).
 */
export const instanceKeys = {
  all: ["instance"] as const,
  version: () => [...instanceKeys.all, "version"] as const,
};

/**
 * The running build's version identity (`GET /instance/version`, ADR-0083). Authenticated read used
 * by Settings → Instance. The value is baked into the image at build time, so it can only change on
 * a redeploy — a long `staleTime` keeps this from refetching on every focus.
 */
export function useInstanceVersion() {
  return useQuery({
    queryKey: instanceKeys.version(),
    // Wrapped (not passed bare) so TanStack's QueryFunctionContext is never forwarded as the
    // getter's optional SSR `token` arg (ADR-0067); client callers always send no token.
    queryFn: () => getInstanceVersion(),
    staleTime: 60 * 60 * 1000,
  });
}

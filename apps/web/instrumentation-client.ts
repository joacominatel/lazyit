/**
 * Client instrumentation — Next runs this before any application code and before hydration.
 *
 * Only one job today: put zod in jitless mode so its `new Function` capability probe never trips the
 * Content-Security-Policy (#1440, see `disableZodJit`). Keep this file tiny: it is on every page's
 * critical path.
 */
import { disableZodJit } from "@/lib/security/csp";

disableZodJit();

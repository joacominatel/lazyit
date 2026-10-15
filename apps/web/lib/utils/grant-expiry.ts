import { ApiError } from "@/lib/api/client";

/** The earliest day the expiry picker offers: the grant's own `grantedAt` day, in UTC like the value sent. */
export function grantExpiryMinDate(grantedAt: string): string {
  return new Date(grantedAt).toISOString().slice(0, 10);
}

/** True for the API's 400 refusing an expiry earlier than the grant's `grantedAt` (AUD-097). */
export function isExpiryBeforeGrantedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    /on or after grantedAt/i.test(error.message)
  );
}

import type { UpdateUserPreferences, User } from "@lazyit/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { putUserPreferences } from "../endpoints/account";
import { getSessionToken } from "../session-token";
import { userKeys } from "./use-users";

/**
 * Save a language or theme change to the caller's account (`PUT /account/preferences`, issue #1422) —
 * fire-and-forget. The switch itself already happened in the browser (cookie / next-themes); this only
 * makes it follow the user to a browser that has no value of its own.
 *
 * Deliberately NOT a `useMutation`: it must never block, toast or trip the global 401 / forced-password
 * reactions — a failed save (an older API without the route, a network blip) just means the choice stays
 * in this browser. It is skipped where no API session token exists (the sign-in and public Help pages
 * also render the theme and language switchers). On success `/users/me` is patched so the cached copy
 * matches what the server stored.
 */
export function useSavePreference(): (
  patch: UpdateUserPreferences | null,
) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (patch) => {
      if (!patch || !getSessionToken()) return;
      putUserPreferences(patch)
        .then((stored) => {
          queryClient.setQueryData<User>(userKeys.me(), (me) =>
            me ? { ...me, ...stored } : me,
          );
        })
        .catch(() => {
          // Best effort: the browser keeps the choice either way.
        });
    },
    [queryClient],
  );
}

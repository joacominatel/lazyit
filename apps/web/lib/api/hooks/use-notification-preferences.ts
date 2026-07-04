import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationType } from "@lazyit/shared";
import {
  getNotificationPreferences,
  putNotificationPreferences,
  type NotificationPreferences,
} from "../endpoints/account";

/**
 * Read + write hooks for the caller's notification-EMAIL preferences (issue #879, ADR-0020 mold).
 * Self-scope for any signed-in human (the API resolves "me"), so this runs for every user — no
 * permission gate. The write is an optimistic, full-replacement PUT of the opted-out set: the toggle
 * flips instantly, the server confirms with the fresh shape, and a failure rolls the row back +
 * toasts (handled by the caller's `onError`).
 */
export const notificationPreferenceKeys = {
  all: ["account", "notification-preferences"] as const,
};

/** The caller's notification-email preferences (`GET /account/notification-preferences`). */
export function useNotificationPreferences() {
  return useQuery({
    queryKey: notificationPreferenceKeys.all,
    queryFn: () => getNotificationPreferences(),
  });
}

/**
 * Replace the caller's opted-out set (`PUT /account/notification-preferences`). Optimistic: the new
 * `optedOutTypes` is written into the cache immediately (the switch reflects the intent with no
 * flicker), rolled back on error, and reconciled with the server's authoritative shape on success.
 */
export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (optedOutTypes: NotificationType[]) =>
      putNotificationPreferences(optedOutTypes),
    onMutate: async (optedOutTypes) => {
      await queryClient.cancelQueries({
        queryKey: notificationPreferenceKeys.all,
      });
      const previous = queryClient.getQueryData<NotificationPreferences>(
        notificationPreferenceKeys.all,
      );
      if (previous) {
        queryClient.setQueryData<NotificationPreferences>(
          notificationPreferenceKeys.all,
          { ...previous, optedOutTypes },
        );
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          notificationPreferenceKeys.all,
          context.previous,
        );
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(notificationPreferenceKeys.all, data);
    },
  });
}

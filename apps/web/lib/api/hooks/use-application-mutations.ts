import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateApplication, UpdateApplication } from "@lazyit/shared";
import {
  createApplication,
  deleteApplication,
  updateApplication,
} from "../endpoints/applications";
import { applicationKeys } from "./use-applications";

/** Application writes — each invalidates `applicationKeys.all` so the list and detail refetch. */
function useInvalidateApplications() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: applicationKeys.all });
}

export function useCreateApplication() {
  const invalidate = useInvalidateApplications();
  return useMutation({
    mutationFn: (data: CreateApplication) => createApplication(data),
    onSuccess: invalidate,
  });
}

export function useUpdateApplication() {
  const invalidate = useInvalidateApplications();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateApplication }) =>
      updateApplication(id, data),
    onSuccess: invalidate,
  });
}

export function useDeleteApplication() {
  const invalidate = useInvalidateApplications();
  return useMutation({
    mutationFn: (id: string) => deleteApplication(id),
    onSuccess: invalidate,
  });
}

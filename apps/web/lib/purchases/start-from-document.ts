import type { PurchaseExtractionStatus } from "@lazyit/shared";
import { fileProblem, maxBytesFor, referenceFromFileName } from "./extraction";

// The one pipeline behind the New purchase button and a document dropped on New purchase or the list (#1516).

export const START_STEPS = ["create", "attach", "open"] as const;
export type StartStep = (typeof START_STEPS)[number];

export function toWholeMb(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

export function canStartFromDocument(
  canWrite: boolean,
  status: Pick<PurchaseExtractionStatus, "available"> | undefined,
): boolean {
  return canWrite && status?.available === true;
}

export function firstFile<T>(files: ArrayLike<T> | null | undefined): { file: T | null; extra: boolean } {
  const count = files?.length ?? 0;
  return { file: count > 0 ? files![0]! : null, extra: count > 1 };
}

type StartRefusal =
  | { key: "wrongType"; values: { name: string } }
  | { key: "tooLarge"; values: { name: string; max: number } };

export function startRefusal(
  status: Pick<PurchaseExtractionStatus, "mediaTypes" | "maxBytes" | "maxBytesByMediaType">,
  file: { name: string; type: string; size: number },
): StartRefusal | null {
  const problem = fileProblem(status, file);
  if (problem === "type") return { key: "wrongType", values: { name: file.name } };
  if (problem === "size") {
    return { key: "tooLarge", values: { name: file.name, max: toWholeMb(maxBytesFor(status, file.type)) } };
  }
  return null;
}

export interface StartEffects<F> {
  create: (reference: string) => Promise<{ id: string }>;
  upload: (purchaseId: string, file: F) => Promise<{ id: string; originalName: string }>;
  rename: (purchaseId: string, reference: string) => Promise<unknown>;
  open: (href: string) => void;
  step: (step: StartStep) => void;
  failed: (stage: "create" | "upload" | "rename", error: unknown) => void;
}

// "hold" once it navigates: runExclusive keeps the lock until the page changes, so a second file cannot start a
// second purchase in that moment.
export async function startFromDocument<F extends { name: string }>(
  file: F,
  fx: StartEffects<F>,
): Promise<"hold" | undefined> {
  fx.step("create");
  const reference = referenceFromFileName(file.name);
  let purchaseId: string;
  try {
    purchaseId = (await fx.create(reference)).id;
  } catch (error) {
    fx.failed("create", error);
    return undefined;
  }

  fx.step("attach");
  let attachment: { id: string; originalName: string };
  try {
    attachment = await fx.upload(purchaseId, file);
  } catch (error) {
    fx.failed("upload", error);
    fx.open(`/purchases/${purchaseId}`);
    return "hold";
  }

  // The server may normalize the name; a failed rename still opens the review, the reference then reads as the purchase's own.
  const stored = referenceFromFileName(attachment.originalName);
  if (stored !== reference) {
    try {
      await fx.rename(purchaseId, stored);
    } catch (error) {
      fx.failed("rename", error);
    }
  }

  fx.step("open");
  fx.open(`/purchases/${purchaseId}/review/${attachment.id}?read=1`);
  return "hold";
}

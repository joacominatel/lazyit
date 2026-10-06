"use client";

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { usePathname } from "next/navigation";
import { useAiChatAvailable } from "@/lib/api/hooks/use-ai-status";

/**
 * The AI assistant's shell state (ADR-0097; docs/ai-assistant/frontend.md §5.2). Mounted once in the
 * `(app)` layout — never in `template.tsx`, which re-mounts on every navigation — so an open panel and,
 * later, an in-flight run survive moving between pages.
 *
 * It renders NO element of its own: the children keep their exact place in the layout's flex row, and
 * while the assistant is unavailable the shell is byte-for-byte the one without it. Availability comes
 * from the server (`GET /ai/status`) and fails closed — see `isAiChatAvailable`.
 */
export interface AiAssistantState {
  /** The server said the caller may use the chat. False while loading, on any error, and when off. */
  available: boolean;
  /** The panel is showing. Always false while unavailable. */
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** The launcher button, so closing the panel can hand focus back to it. */
  launcherRef: RefObject<HTMLButtonElement | null>;
  /** The panel's element id, for the launcher's `aria-controls`. */
  panelId: string;
  /**
   * A message an entry point prepared for the composer, waiting for the chat to take it (#1478 — "Ask AI to
   * fill" on a purchase document). `seq` tells two equal texts apart. It is dropped when the panel closes or
   * the page changes before the chat took it.
   */
  prefill: AiPrefill | null;
  /**
   * Opens the panel with `text` in the composer, ready to review and send. It is NEVER sent by itself: the
   * person sends it (with the current page as context, like any message). A no-op while unavailable.
   */
  ask: (text: string) => void;
  /** The composer took the prefill. */
  clearPrefill: () => void;
}

/** A prepared message, from {@link AiAssistantState.ask}. */
export interface AiPrefill {
  text: string;
  seq: number;
}

const OFF: AiAssistantState = {
  available: false,
  open: false,
  setOpen: () => {},
  toggle: () => {},
  launcherRef: { current: null },
  panelId: "",
  prefill: null,
  ask: () => {},
  clearPrefill: () => {},
};

const AiAssistantContext = createContext<AiAssistantState>(OFF);

export function AiAssistantRoot({ children }: { children: React.ReactNode }) {
  const available = useAiChatAvailable();
  const [open, setOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const toggle = useCallback(() => setOpen((prev) => !prev), []);
  const pathname = usePathname();
  // The prepared message and the page it was prepared on.
  const [prefill, setPrefill] = useState<(AiPrefill & { path: string | null }) | null>(null);
  // Never reset, so every ask is a new one to the chat even after it took the last.
  const askSeq = useRef(0);
  const ask = useCallback(
    (text: string) => {
      askSeq.current += 1;
      setPrefill({ text, seq: askSeq.current, path: pathname });
      setOpen(true);
    },
    [pathname],
  );
  const clearPrefill = useCallback(() => setPrefill(null), []);
  // Not taken yet and the panel closed, or the person moved to another page: the message is dropped, so it
  // never lands later in a chat about something else.
  if (prefill !== null && (!(available && open) || prefill.path !== pathname)) setPrefill(null);

  const state = useMemo<AiAssistantState>(
    () => ({
      available,
      // Losing access (AI turned off, `ai:use` revoked) closes the panel with the launcher.
      open: available && open,
      setOpen,
      toggle,
      launcherRef,
      panelId,
      prefill: available && prefill !== null ? { text: prefill.text, seq: prefill.seq } : null,
      ask: available ? ask : OFF.ask,
      clearPrefill,
    }),
    [available, open, toggle, panelId, prefill, ask, clearPrefill],
  );

  return <AiAssistantContext.Provider value={state}>{children}</AiAssistantContext.Provider>;
}

/** The assistant's shell state. Outside {@link AiAssistantRoot} it reads as unavailable. */
export function useAiAssistant(): AiAssistantState {
  return useContext(AiAssistantContext);
}

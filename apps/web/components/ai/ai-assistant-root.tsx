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
}

const OFF: AiAssistantState = {
  available: false,
  open: false,
  setOpen: () => {},
  toggle: () => {},
  launcherRef: { current: null },
  panelId: "",
};

const AiAssistantContext = createContext<AiAssistantState>(OFF);

export function AiAssistantRoot({ children }: { children: React.ReactNode }) {
  const available = useAiChatAvailable();
  const [open, setOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  const state = useMemo<AiAssistantState>(
    () => ({
      available,
      // Losing access (AI turned off, `ai:use` revoked) closes the panel with the launcher.
      open: available && open,
      setOpen,
      toggle,
      launcherRef,
      panelId,
    }),
    [available, open, toggle, panelId],
  );

  return <AiAssistantContext.Provider value={state}>{children}</AiAssistantContext.Provider>;
}

/** The assistant's shell state. Outside {@link AiAssistantRoot} it reads as unavailable. */
export function useAiAssistant(): AiAssistantState {
  return useContext(AiAssistantContext);
}

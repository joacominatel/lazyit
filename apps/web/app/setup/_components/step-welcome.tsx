import { CheckCircleIcon, ServerStackIcon, KeyIcon } from "@heroicons/react/24/outline";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { IdpChoice } from "./types";
import { ByoiSnippet } from "./byoi-snippet";

interface Option {
  value: IdpChoice;
  title: string;
  description: string;
  icon: typeof ServerStackIcon;
}

const OPTIONS: Option[] = [
  {
    value: "zitadel",
    title: "Bundled Zitadel",
    description:
      "The recommended self-hosted identity provider, set up for you. No external accounts to wire.",
    icon: ServerStackIcon,
  },
  {
    value: "byoi",
    title: "Bring your own OIDC",
    description:
      "Point lazyit at an OIDC provider you already run (Okta, Authentik, Keycloak, Entra ID…).",
    icon: KeyIcon,
  },
];

/**
 * Step 1 — Welcome + IdP choice (ADR-0043 §7a step 1). Two selectable cards (a radiogroup) for the
 * bundled-Zitadel vs. BYOI fork; choosing BYOI reveals the three env vars to configure. The choice
 * only drives the guidance copy — the backend authoritatively reports the live mode.
 */
export function StepWelcome({
  choice,
  onChoiceChange,
  onNext,
}: {
  choice: IdpChoice;
  onChoiceChange: (choice: IdpChoice) => void;
  onNext: () => void;
}) {
  return (
    <>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          How do you want users to sign in to lazyit?
        </p>
        <div
          role="radiogroup"
          aria-label="Identity provider"
          className="grid gap-3 sm:grid-cols-2"
        >
          {OPTIONS.map((option) => {
            const selected = choice === option.value;
            const Icon = option.icon;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChoiceChange(option.value)}
                className={cn(
                  "group relative flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40 hover:bg-muted/50",
                )}
              >
                {selected && (
                  <CheckCircleIcon className="absolute right-3 top-3 size-5 text-primary" />
                )}
                <Icon className="size-6 text-primary" />
                <span className="text-sm font-medium">{option.title}</span>
                <span className="text-xs text-muted-foreground">
                  {option.description}
                </span>
              </button>
            );
          })}
        </div>

        {choice === "byoi" && <ByoiSnippet />}
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={onNext}>Continue</Button>
      </CardFooter>
    </>
  );
}

"use client";

import { ChevronUpDownIcon } from "@heroicons/react/24/outline";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/user-avatar";
import { setActingUserId, useActingUserId } from "@/lib/api/acting-user";
import { useUsers } from "@/lib/api/hooks/use-users";
import { cn } from "@/lib/utils";

/**
 * Dev-only "act as" switcher for the `X-User-Id` auth shim (ADR-0022). Picks
 * which existing user the API calls are attributed to, so draft visibility can
 * be exercised by hand (an author sees their DRAFTs; everyone else gets a 404).
 * Persisted via the acting-user store; changing it invalidates every query so
 * visibility re-resolves. Hidden in production — it is strictly a stand-in until
 * real auth (ADR-0016) lands.
 */
export function UserSwitcher() {
  if (process.env.NODE_ENV === "production") return null;
  return <UserSwitcherMenu />;
}

function UserSwitcherMenu() {
  const queryClient = useQueryClient();
  const actingUserId = useActingUserId();
  const { data: users } = useUsers();
  const current = users?.find((user) => user.id === actingUserId);

  function selectUser(id: string | undefined) {
    setActingUserId(id);
    // Re-resolve draft visibility (and anything else identity-dependent).
    queryClient.invalidateQueries();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          {current ? (
            <UserAvatar
              firstName={current.firstName}
              lastName={current.lastName}
              email={current.email}
              size="sm"
            />
          ) : null}
          <span
            className={cn(
              "max-w-[140px] truncate",
              !current && "text-muted-foreground",
            )}
          >
            {current ? `${current.firstName} ${current.lastName}` : "Anonymous"}
          </span>
          <ChevronUpDownIcon className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Act as · dev (X-User-Id)</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={actingUserId ?? ""}
          onValueChange={(value) => selectUser(value || undefined)}
        >
          <DropdownMenuRadioItem value="">
            Anonymous (published only)
          </DropdownMenuRadioItem>
          {(users ?? []).map((user) => (
            <DropdownMenuRadioItem key={user.id} value={user.id}>
              {user.firstName} {user.lastName}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

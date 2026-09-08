import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Compass, Gamepad2, Home, User } from "lucide-react";
import { viewerHandleAtom } from "@/atoms/session";
import { m } from "@/paraglide/messages.js";

const itemClassName =
  "text-muted-foreground hover:bg-muted focus-visible:ring-ring flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-xs font-medium outline-none focus-visible:ring-2";
const activeProps = { className: "bg-primary/10 text-primary" };

export function MobileNavigation() {
  const handle = useAtomValue(viewerHandleAtom);
  return (
    <nav
      aria-label={m.nav_primary()}
      className="bg-background/95 fixed inset-x-0 bottom-0 z-40 border-t px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <div className="flex h-16 gap-1 py-1">
        <Link
          to="/"
          activeOptions={{ exact: true }}
          activeProps={activeProps}
          className={itemClassName}
        >
          <Home className="size-5" />
          {m.nav_home()}
        </Link>
        <Link to="/discover" activeProps={activeProps} className={itemClassName}>
          <Compass className="size-5" />
          {m.nav_discover()}
        </Link>
        <Link to="/games" activeProps={activeProps} className={itemClassName}>
          <Gamepad2 className="size-5" />
          {m.nav_games()}
        </Link>
        {handle ? (
          <Link
            to="/@{$username}"
            params={{ username: handle }}
            activeProps={activeProps}
            className={itemClassName}
          >
            <User className="size-5" />
            {m.nav_profile()}
          </Link>
        ) : (
          <Link to="/welcome" activeProps={activeProps} className={itemClassName}>
            <User className="size-5" />
            {m.nav_profile()}
          </Link>
        )}
      </div>
    </nav>
  );
}

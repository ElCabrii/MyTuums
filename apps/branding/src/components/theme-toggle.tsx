import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";
import { toggleTheme } from "@/lib/theme";

/**
 * Light/dark toggle. The resolved theme lives on `<html>`'s class list (see
 * src/lib/theme.ts), so this is one stateless button over one function —
 * no state to render from, nothing to re-render until the next paint.
 */
export function ThemeToggle() {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={m.theme_toggle()}
      title={m.theme_toggle()}
      onClick={toggleTheme}
    >
      {/* Both icons present, each visible only in the other theme: the sun
          on dark backgrounds, the moon on light ones. CSS decides, so the
          button never needs to know the current theme in JS. */}
      <Sun className="hidden size-5 dark:block" />
      <Moon className="size-5 dark:hidden" />
    </Button>
  );
}

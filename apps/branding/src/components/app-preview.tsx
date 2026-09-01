import { Bookmark, Heart, MessageCircle, MoreHorizontal, Repeat2 } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { m } from "@/paraglide/messages.js";

/**
 * A static mock of one post, composed from the app's own primitives and
 * layout vocabulary (avatar + name + handle, text, quoted card, action row).
 * It is a picture of the product, not an interactive widget — the action row
 * is aria-hidden decorative, and the whole figure is labelled once.
 */
export function AppPreview() {
  return (
    <figure aria-label={m.preview_label()} className="mx-auto mt-16 max-w-md text-left">
      <Card className="p-4 shadow-lg shadow-black/5 sm:p-5">
        <div className="flex items-start gap-3">
          <Avatar className="size-10">
            <AvatarFallback className="bg-primary/10 text-primary">N</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm">
              <span className="truncate font-semibold">Nova</span>
              <span className="text-muted-foreground truncate">@nova</span>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="text-muted-foreground shrink-0 whitespace-nowrap">
                {m.mock_post_time()}
              </span>
              <MoreHorizontal
                aria-hidden="true"
                className="text-muted-foreground ml-auto size-4 shrink-0"
              />
            </div>
            <p className="mt-1.5 text-sm leading-relaxed">{m.mock_post_text()}</p>
            {/* The embedded quote — the mock's own "attachment": a nested
                card in the app's quoted-post style. */}
            <blockquote className="border-border/60 bg-muted/40 mt-3 rounded-xl border p-3">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="font-semibold">Ray</span>
                <span className="text-muted-foreground">@rayplays</span>
              </div>
              <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                {m.mock_quoted_text()}
              </p>
            </blockquote>
          </div>
        </div>
        <div
          aria-hidden="true"
          className="border-border/60 text-muted-foreground mt-3 flex items-center justify-between border-t pt-3 pl-13 text-xs"
        >
          <span className="inline-flex items-center gap-1.5">
            <MessageCircle className="size-4" />
            12
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Repeat2 className="size-4" />8
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Heart className="text-primary size-4 fill-current" />
            47
          </span>
          <Bookmark className="size-4" />
        </div>
      </Card>
    </figure>
  );
}

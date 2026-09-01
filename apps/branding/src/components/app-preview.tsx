import { Bookmark, Heart, MessageCircle, MoreHorizontal, Quote, Repeat2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { getLocale } from "@/paraglide/runtime.js";
import { m } from "@/paraglide/messages.js";

/**
 * A static replica of one `PostCard` (apps/web/src/components/post-card.tsx),
 * mirroring the real component's markup and classes row for row — avatar
 * column, header line, content paragraph, action bar. The real component
 * cannot be imported here: it is wired into the SPA's Jotai store, oRPC
 * client and router, none of which may ship on the branding host. When the
 * real card's layout changes, this replica follows by hand; the Card around
 * it is the landing page's framing device, not part of the app's chrome.
 *
 * The post itself is fixture data rather than translated copy — a real
 * author posting real words reads the same in every locale.
 */
const POST_AUTHOR_NAME = "ElCabri";
const POST_AUTHOR_HANDLE = "elcabri";
/**
 * The author's GitHub profile picture, not a `/media/` URL: every `/media`
 * key sits behind the session gate and would 401 for the signed-out visitors
 * who make up a landing page's audience. The GitHub CDN copy is public and
 * allowed by the app's CSP (`img-src ... https:`). `s=96` doubles the 40 px
 * render box for sharp screens; the "E" fallback stays for load failures.
 */
const POST_AUTHOR_AVATAR = "https://avatars.githubusercontent.com/u/14412169?s=96";
const POST_CONTENT =
  "What are your opinions on the new patchnote ? It seems very unbalanced, but im might be biased tbh";
const POST_HASHTAG = "#leagueoflegends";

/**
 * The timestamp renders exactly the way `PostTimestamps` does in the app:
 * `Intl.RelativeTimeFormat` with `numeric: "auto"` over a fixed instant two
 * hours ago — "2 hours ago" / "il y a 2 heures" — with the exact time on
 * hover. Computed at module scope: switching locale reloads the document
 * (`setLocale`'s default), so a fresh import re-resolves the language.
 */
const POST_DATE = new Date(Date.now() - 2 * 60 * 60 * 1000);
const POST_TIME_LABEL = new Intl.RelativeTimeFormat(getLocale(), {
  numeric: "auto",
}).format(-2, "hour");
const POST_TIME_EXACT = new Intl.DateTimeFormat(getLocale(), {
  dateStyle: "medium",
  timeStyle: "short",
}).format(POST_DATE);

/** Plausible engagement for the fixture; the row is decorative (aria-hidden). */
const POST_REPLIES = 24;
const POST_REPOSTS = 6;
const POST_LIKES = 47;

export function AppPreview() {
  return (
    <figure aria-label={m.preview_label()} className="mx-auto mt-16 max-w-md text-left">
      <Card className="p-4 shadow-lg shadow-black/5 sm:p-5">
        <div className="flex gap-3">
          <Avatar className="bg-background h-10 w-10 shrink-0 rounded-full">
            <AvatarImage src={POST_AUTHOR_AVATAR} alt={POST_AUTHOR_NAME} />
            <AvatarFallback className="bg-primary text-primary-foreground rounded-full text-xs font-bold">
              E
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <span className="text-foreground truncate text-sm font-bold">{POST_AUTHOR_NAME}</span>
              <span className="text-muted-foreground text-xs">@{POST_AUTHOR_HANDLE}</span>
              <span className="text-muted-foreground text-xs">
                •{" "}
                <time dateTime={POST_DATE.toISOString()} title={POST_TIME_EXACT}>
                  {POST_TIME_LABEL}
                </time>
              </span>
              <span
                aria-hidden="true"
                className="text-muted-foreground ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
              >
                <MoreHorizontal className="h-4 w-4" />
              </span>
            </div>
            <p className="text-foreground/90 mb-3 text-sm leading-relaxed break-words whitespace-pre-line">
              {POST_CONTENT}{" "}
              {/* The app's linkifier renders a hashtag as a search link with
                  the link color — replica of `LinkedText`'s hashtag arm. */}
              <span className="text-primary hover:underline">{POST_HASHTAG}</span>
            </p>
            <div
              aria-hidden="true"
              className="text-muted-foreground flex max-w-md items-center gap-6 text-xs"
            >
              <span className="flex items-center gap-1.5">
                <MessageCircle className="h-4 w-4" />
                <span>{POST_REPLIES}</span>
              </span>
              <span className="hover:text-primary flex items-center gap-1.5 transition-colors">
                <Repeat2 className="h-4 w-4" />
                <span>{POST_REPOSTS}</span>
              </span>
              <span className="hover:text-primary flex items-center gap-1.5 transition-colors">
                <Quote className="h-4 w-4" />
              </span>
              <span className="hover:text-destructive flex items-center gap-1.5 transition-colors">
                <Heart className="h-4 w-4" />
                <span>{POST_LIKES}</span>
              </span>
              <span className="hover:text-primary flex items-center gap-1.5 transition-colors">
                <Bookmark className="h-4 w-4" />
              </span>
            </div>
          </div>
        </div>
      </Card>
    </figure>
  );
}

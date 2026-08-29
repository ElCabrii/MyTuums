import { createFileRoute } from "@tanstack/react-router";
import { ThreadPage } from "@/components/thread-page";
import { m } from "@/paraglide/messages.js";
import { pageHead } from "@/lib/document-head";

/** The single-post thread route (`/post/$postId`) — renders `ThreadPage`. */
export const Route = createFileRoute("/post/$postId")({
  head: ({ params }) =>
    pageHead(m.post_title(), undefined, `/post/${encodeURIComponent(params.postId)}`),
  component: ThreadPage,
});

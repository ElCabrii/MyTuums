import { createFileRoute } from "@tanstack/react-router";
import { ThreadPage } from "@/components/thread-page";

/** The single-post thread route (`/post/$postId`) — renders `ThreadPage`. */
export const Route = createFileRoute("/post/$postId")({
  component: ThreadPage,
});

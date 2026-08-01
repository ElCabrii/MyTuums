import { createFileRoute } from "@tanstack/react-router";
import { ThreadPage } from "@/components/thread-page";

export const Route = createFileRoute("/post/$postId")({
  component: ThreadPage,
});

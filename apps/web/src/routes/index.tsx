import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/components/home-page";

/** The home feed route (`/`) — renders `HomePage`. */
export const Route = createFileRoute("/")({
  component: HomePage,
});

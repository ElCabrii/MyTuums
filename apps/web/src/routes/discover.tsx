import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/discover")({
  component: DiscoverPage,
});

function DiscoverPage() {
  return null;
}

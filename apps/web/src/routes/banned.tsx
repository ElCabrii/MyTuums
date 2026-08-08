import { createFileRoute } from "@tanstack/react-router";
import { BannedPage } from "@/components/banned-page";

export const Route = createFileRoute("/banned")({
  component: BannedPage,
});

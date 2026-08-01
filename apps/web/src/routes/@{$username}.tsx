import { createFileRoute } from "@tanstack/react-router";
import { ProfileLayout } from "@/components/profile-layout";

export const Route = createFileRoute("/@{$username}")({
  component: ProfileLayout,
});

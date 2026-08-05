import { createFileRoute } from "@tanstack/react-router";
import { ProfileLayout } from "@/components/profile-layout";

/** The profile layout route — the persistent banner/avatar/follow chrome every `/@{$username}` page renders inside. */
export const Route = createFileRoute("/@{$username}")({
  component: ProfileLayout,
});

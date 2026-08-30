import { createFileRoute } from "@tanstack/react-router";
import { ProfileLayout } from "@/components/profile-layout";
import { pageHead } from "@/lib/document-head";

/** The profile layout route — the persistent banner/avatar/follow chrome every `/@{$username}` page renders inside. */
export const Route = createFileRoute("/@{$username}")({
  head: ({ params }) =>
    pageHead(`@${params.username}`, undefined, `/@${encodeURIComponent(params.username)}`),
  component: ProfileLayout,
});

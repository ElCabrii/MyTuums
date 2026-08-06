import { useAtomValue } from "jotai";
import { isStaffAtom } from "@/atoms/session";
import { useRequireRole } from "@/hooks/use-require-role";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuditView } from "@/components/moderation/audit-view";
import { QueueView } from "@/components/moderation/queue-view";
import { RoleForbiddenPage } from "@/components/moderation/role-forbidden-page";
import { TeamView } from "@/components/moderation/team-view";
import { m } from "@/paraglide/messages.js";

/**
 * The moderation desk — queue for moderators and up, audit log and team for
 * staff and up. The route body, not the route: the gate is client-side
 * convenience (server procedures re-check every call), so the page renders
 * the forbidden card rather than redirecting when the role is missing.
 */
export function ModerationPage() {
  const isModerator = useRequireRole("moderator");
  const isStaff = useAtomValue(isStaffAtom);

  if (!isModerator) return <RoleForbiddenPage />;

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-4 text-2xl font-bold tracking-tight">{m.moderation_title()}</h1>
      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">{m.moderation_tab_queue()}</TabsTrigger>
          {isStaff && <TabsTrigger value="audit">{m.moderation_tab_audit()}</TabsTrigger>}
          {isStaff && <TabsTrigger value="team">{m.moderation_tab_team()}</TabsTrigger>}
        </TabsList>
        <TabsContent value="queue" className="mt-4">
          <QueueView />
        </TabsContent>
        {isStaff && (
          <>
            <TabsContent value="audit" className="mt-4">
              <AuditView />
            </TabsContent>
            <TabsContent value="team" className="mt-4">
              <TeamView />
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}

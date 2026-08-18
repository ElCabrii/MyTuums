import { useAtomValue } from "jotai";
import { ClipboardList, Inbox, Users } from "lucide-react";
import { isStaffAtom } from "@/atoms/session";
import { useRequireRole } from "@/hooks/use-require-role";
import { Separator } from "@/components/ui/separator";
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
 *
 * Wider than the reading pages (`max-w-4xl` against the feed's `max-w-2xl`):
 * this is a work surface, and the audit log's four columns are unreadable
 * squeezed into a column sized for prose.
 */
export function ModerationPage() {
  const isModerator = useRequireRole("moderator");
  const isStaff = useAtomValue(isStaffAtom);

  if (!isModerator) return <RoleForbiddenPage />;

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      {/* Same header shape as `/settings/account` — title then one line of
            subtitle — so the two work surfaces of the app read alike. */}
      <div className="mb-6 space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{m.moderation_title()}</h1>
        <p className="text-muted-foreground text-sm">{m.moderation_subtitle()}</p>
      </div>

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">
            <Inbox />
            {m.moderation_tab_queue()}
          </TabsTrigger>
          {isStaff && (
            <TabsTrigger value="audit">
              <ClipboardList />
              {m.moderation_tab_audit()}
            </TabsTrigger>
          )}
          {isStaff && (
            <TabsTrigger value="team">
              <Users />
              {m.moderation_tab_team()}
            </TabsTrigger>
          )}
        </TabsList>
        <Separator className="mt-3" />
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

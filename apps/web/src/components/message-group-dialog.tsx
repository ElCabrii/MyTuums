import { useState } from "react";
import { useAtomValue } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import { Users, X } from "lucide-react";
import { GROUP_MEMBER_LIMIT, GROUP_NAME_MAX_LENGTH } from "@my-tuums/api/constants";
import { hideConversationAtom } from "@/atoms/messages";
import { groupCommandAtom } from "@/atoms/message-groups";
import { typeaheadQueryAtomFamily } from "@/atoms/search";
import { viewerIdAtom } from "@/atoms/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserAvatar } from "@/components/user-avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ConversationItem, SearchTypeahead } from "@/lib/orpc";
import { m } from "@/paraglide/messages.js";

type Person = SearchTypeahead["users"][number];
type Group = NonNullable<ConversationItem["group"]>;

export function CreateGroupButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Users aria-hidden="true" />
        {m.groups_create()}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <GroupEditor onClose={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

export function GroupDetailsButton({
  conversationId,
  group,
}: {
  conversationId: string;
  group: Group;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {m.groups_details({ count: group.members.length })}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <GroupEditor
            conversationId={conversationId}
            group={group}
            onClose={() => setOpen(false)}
          />
        )}
      </Dialog>
    </>
  );
}

function GroupEditor({
  conversationId,
  group,
  onClose,
}: {
  conversationId?: string;
  group?: Group;
  onClose: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [selected, setSelected] = useState<Person[]>([]);
  const [error, setError] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const command = useAtomValue(groupCommandAtom);
  const hide = useAtomValue(hideConversationAtom);
  const viewerId = useAtomValue(viewerIdAtom);
  const navigate = useNavigate();
  const failure = () => setError(true);
  const options = { onError: failure };
  return (
    <DialogContent className="max-h-[85dvh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{group ? m.groups_manage() : m.groups_create()}</DialogTitle>
        <DialogDescription>{m.groups_description({ count: GROUP_MEMBER_LIMIT })}</DialogDescription>
      </DialogHeader>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(false);
          if (conversationId)
            command.mutate(
              { action: "rename", conversationId, name },
              { ...options, onSuccess: onClose },
            );
          else
            command.mutate(
              { action: "create", name, recipientIds: selected.map((person) => person.id) },
              {
                ...options,
                onSuccess: (result) => {
                  onClose();
                  void navigate({
                    to: "/messages/$conversationId",
                    params: { conversationId: result.conversationId },
                  });
                },
              },
            );
        }}
      >
        <Label htmlFor="group-name">{m.groups_name()}</Label>
        <Input
          id="group-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={GROUP_NAME_MAX_LENGTH}
          required
        />
        {!group && (
          <>
            <PeoplePicker
              exclude={[viewerId ?? "", ...selected.map((person) => person.id)]}
              disabled={selected.length >= GROUP_MEMBER_LIMIT - 1}
              onSelect={(person) => setSelected([...selected, person])}
            />
            <div className="flex flex-wrap gap-2">
              {selected.map((person) => (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  key={person.id}
                  onClick={() => setSelected(selected.filter((item) => item.id !== person.id))}
                  aria-label={m.groups_unselect({ name: person.name })}
                >
                  {person.name}
                  <X aria-hidden="true" />
                </Button>
              ))}
            </div>
          </>
        )}
        <Button
          type="submit"
          disabled={command.isPending || !name.trim() || (!group && !selected.length)}
        >
          {group ? m.groups_save() : m.groups_create()}
        </Button>
      </form>
      {group && conversationId && (
        <>
          <ul className="space-y-2">
            {group.members.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {member.name}
                  {member.username && (
                    <span className="text-muted-foreground"> @{member.username}</span>
                  )}
                </span>
                {member.id !== viewerId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={command.isPending}
                    onClick={() => setRemoveId(member.id)}
                  >
                    {m.groups_remove()}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {removeId && (
            <div className="space-y-2 rounded-lg border p-3">
              <p>{m.groups_remove_confirm()}</p>
              <Button
                variant="destructive"
                disabled={command.isPending}
                onClick={() =>
                  command.mutate(
                    { action: "remove", conversationId, userId: removeId },
                    { ...options, onSuccess: () => setRemoveId(null) },
                  )
                }
              >
                {m.groups_remove()}
              </Button>
              <Button variant="ghost" onClick={() => setRemoveId(null)}>
                {m.common_cancel()}
              </Button>
            </div>
          )}
          <PeoplePicker
            exclude={group.members.map((member) => member.id)}
            disabled={group.members.length >= GROUP_MEMBER_LIMIT || command.isPending}
            onSelect={(person) =>
              command.mutate(
                { action: "invite", conversationId, userId: person.id },
                { ...options, onSuccess: onClose },
              )
            }
          />
          <Button
            variant="outline"
            disabled={hide.isPending}
            onClick={() =>
              hide.mutate(
                { conversationId },
                {
                  onError: failure,
                  onSuccess: () => {
                    onClose();
                    void navigate({ to: "/messages" });
                  },
                },
              )
            }
          >
            {m.messages_hide()}
          </Button>
          <Button
            variant="destructive"
            disabled={command.isPending}
            onClick={() =>
              command.mutate(
                { action: "leave", conversationId },
                {
                  ...options,
                  onSuccess: () => {
                    onClose();
                    void navigate({ to: "/messages" });
                  },
                },
              )
            }
          >
            {m.groups_leave()}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {m.groups_action_error()}
        </p>
      )}
    </DialogContent>
  );
}

function PeoplePicker({
  exclude,
  disabled,
  onSelect,
}: {
  exclude: string[];
  disabled: boolean;
  onSelect: (person: Person) => void;
}) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const results = useAtomValue(typeaheadQueryAtomFamily(submitted));
  return (
    <div className="space-y-2">
      <Label htmlFor="group-people">{m.groups_invite()}</Label>
      <div className="flex gap-2">
        <Input
          id="group-people"
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setSubmitted(query);
            }
          }}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || !query.trim()}
          onClick={() => setSubmitted(query)}
        >
          {m.groups_search()}
        </Button>
      </div>
      {results.isError && <p role="alert">{m.messages_load_error()}</p>}
      {results.isFetching && (
        <p className="text-muted-foreground text-sm">{m.messages_loading()}</p>
      )}
      <ul className="space-y-1">
        {results.data?.users
          .filter((person) => !exclude.includes(person.id))
          .map((person) => (
            <li key={person.id}>
              <Button
                className="h-auto w-full justify-start py-2"
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  onSelect(person);
                  setQuery("");
                  setSubmitted("");
                }}
              >
                <span aria-hidden="true" className="shrink-0">
                  <UserAvatar user={person} alt="" className="size-8" />
                </span>
                <span className="min-w-0 truncate">
                  {person.name} <span className="text-muted-foreground">@{person.username}</span>
                </span>
              </Button>
            </li>
          ))}
      </ul>
    </div>
  );
}

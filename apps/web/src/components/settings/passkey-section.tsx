import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, Fingerprint, Loader2, Plus, Trash2, X } from "lucide-react";
import { authPendingAtom } from "@/atoms/auth";
import {
  addPasskeyAtom,
  deletePasskeyAtom,
  editingPasskeyIdAtom,
  newPasskeyNameAtom,
  passkeyNameDraftAtom,
  passkeysAtom,
  renamePasskeyAtom,
  startRenamingPasskeyAtom,
} from "@/atoms/passkey";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Section } from "@/components/settings/section";
import { m } from "@/paraglide/messages.js";

/**
 * The settings card listing the account's passkeys, with add, rename and
 * delete.
 */
export function PasskeySection() {
  const { data: passkeys, isPending } = useAtomValue(passkeysAtom);
  const [newName, setNewName] = useAtom(newPasskeyNameAtom);
  const [nameDraft, setNameDraft] = useAtom(passkeyNameDraftAtom);
  const editingId = useAtomValue(editingPasskeyIdAtom);
  const startRenaming = useSetAtom(startRenamingPasskeyAtom);
  const addPasskey = useSetAtom(addPasskeyAtom);
  const renamePasskey = useSetAtom(renamePasskeyAtom);
  const deletePasskey = useSetAtom(deletePasskeyAtom);
  const isBusy = useAtomValue(authPendingAtom);

  const handleAdd = async () => {
    if (await addPasskey(newName)) setNewName("");
  };

  return (
    <Section
      title={m.passkey_section_title()}
      description={m.passkey_section_description()}
      icon={<Fingerprint className="h-5 w-5" />}
    >
      {isPending ? (
        <p className="text-xs text-muted-foreground">{m.passkey_loading()}</p>
      ) : passkeys && passkeys.length > 0 ? (
        <ul className="space-y-2">
          {passkeys.map((passkey) => (
            <li
              key={passkey.id}
              className="flex items-center gap-2 rounded-2xl border border-border/50 bg-background/40 px-4 py-2.5"
            >
              {editingId === passkey.id ? (
                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void renamePasskey({ id: passkey.id, name: nameDraft }).then(() =>
                      startRenaming(null),
                    );
                  }}
                >
                  <Input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    aria-label={m.passkey_name_label()}
                    className="h-8 bg-background/50"
                    autoFocus
                  />
                  <Button type="submit" size="icon" variant="ghost" aria-label={m.common_save()} disabled={isBusy}>
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={m.common_cancel()}
                    onClick={() => startRenaming(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </form>
              ) : (
                <>
                  <span className="flex-1 text-sm truncate">
                    {passkey.name || m.passkey_unnamed()}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs"
                    onClick={() => startRenaming(passkey)}
                  >
                    {m.passkey_rename()}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={m.passkey_delete_label({ name: passkey.name || m.passkey_unnamed() })}
                    disabled={isBusy}
                    onClick={() => void deletePasskey(passkey.id)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{m.passkey_empty()}</p>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleAdd();
        }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={m.passkey_name_placeholder()}
          aria-label={m.passkey_name_label()}
          className="h-9 bg-background/50"
        />
        <Button type="submit" size="sm" className="rounded-full gap-2 shrink-0" disabled={isBusy}>
          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {m.passkey_add()}
        </Button>
      </form>
    </Section>
  );
}

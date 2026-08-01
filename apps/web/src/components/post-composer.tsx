import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { AlertCircle, Loader2, Send } from "lucide-react";
import { POST_MAX_LENGTH } from "@my-tuums/api/constants";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { viewerAtom } from "@/atoms/session";
import { orpc } from "@/lib/orpc";
import { initialsOf } from "@/lib/user";

export function PostComposer() {
  const user = useAtomValue(viewerAtom);
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");

  const createPost = useMutation(
    orpc.post.create.mutationOptions({
      onSuccess: async () => {
        setContent("");
        // A new post belongs at the top of every feed it qualifies for, and
        // its position depends on server ordering — refetch rather than
        // guess where to splice it in.
        await queryClient.invalidateQueries({ queryKey: orpc.post.list.key() });
      },
    })
  );

  if (!user) return null;

  const trimmed = content.trim();
  const remaining = POST_MAX_LENGTH - content.length;
  const isTooLong = remaining < 0;
  const canSubmit = trimmed.length > 0 && !isTooLong && !createPost.isPending;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        createPost.mutate({ content: trimmed });
      }}
      className="p-4 rounded-xl border border-border bg-card shadow-sm space-y-3"
    >
      <div className="flex gap-3">
        <Avatar className="h-10 w-10 bg-background">
          <AvatarImage src={user.image || undefined} alt={user.name} />
          <AvatarFallback className="bg-primary text-primary-foreground font-bold text-xs">
            {initialsOf(user.name)}
          </AvatarFallback>
        </Avatar>
        <textarea
          rows={2}
          placeholder="Share a gaming update, clip, or tournament result..."
          value={content}
          onChange={(event) => setContent(event.target.value)}
          disabled={createPost.isPending}
          className="w-full resize-none border-none bg-transparent p-0 text-sm focus:outline-none focus:ring-0 placeholder:text-muted-foreground disabled:opacity-60"
        />
      </div>

      {createPost.isError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-2.5 text-xs text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{createPost.error.message || "Could not publish your post. Please try again."}</span>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-3">
        <span
          className={`text-xs tabular-nums ${
            isTooLong
              ? "text-destructive font-semibold"
              : remaining <= 50
                ? "text-foreground"
                : "text-muted-foreground"
          }`}
        >
          {remaining}
        </span>
        <Button type="submit" size="sm" disabled={!canSubmit} className="gap-1.5 rounded-full px-4">
          {createPost.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          <span>Post</span>
        </Button>
      </div>
    </form>
  );
}

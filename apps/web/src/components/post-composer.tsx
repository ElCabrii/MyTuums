import { useAtom, useAtomValue } from "jotai";
import { ComposerForm } from "@/components/composer-form";
import { composerDraftAtom, createPostAtom } from "@/atoms/composer";
import { viewerAtom } from "@/atoms/session";

export function PostComposer() {
  const user = useAtomValue(viewerAtom);
  const [content, setContent] = useAtom(composerDraftAtom);
  const createPost = useAtomValue(createPostAtom);

  if (!user) return null;

  return (
    <ComposerForm
      author={user}
      value={content}
      onValueChange={setContent}
      onSubmit={(body) => {
        createPost.mutate({ content: body });
      }}
      isPending={createPost.isPending}
      errorMessage={
        createPost.isError
          ? createPost.error.message || "Could not publish your post. Please try again."
          : null
      }
      placeholder="Share a gaming update, clip, or tournament result..."
      submitLabel="Post"
    />
  );
}

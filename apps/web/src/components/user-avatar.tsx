import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initialsOf } from "@/lib/user";
import { cn } from "@/lib/utils";

/**
 * The narrowest shape an avatar needs. Deliberately structural rather than one
 * of the generated oRPC types: the same component renders a `Profile`, a
 * `UserSummary`, a post's embedded author and the session user, and none of
 * those four are the same type.
 */
export interface AvatarUser {
  name?: string | null;
  image?: string | null;
}

interface UserAvatarProps {
  user: AvatarUser | null | undefined;
  /** Sizing and any per-site decoration. */
  className?: string;
  /** Applied to the initials, which need their own type scale at large sizes. */
  fallbackClassName?: string;
  /**
   * Overrides the alt text. Defaults to the display name, which is right
   * everywhere the avatar is the only thing identifying the person.
   */
  alt?: string;
}

/**
 * One avatar, rendered the same way everywhere.
 *
 * This existed as five hand-copied `Avatar`/`AvatarImage`/`AvatarFallback`
 * triples — header, composer, post card, user list and the profile page — all
 * structurally identical and all repeating `image || undefined` and
 * `initialsOf(name)`. That was survivable while `user.image` was only ever
 * written by an OAuth provider at sign-up. Now that it is editable, every one of
 * those five had to learn the same new behaviour at once, which is the point at
 * which five copies stops being cheaper than one component.
 *
 * The `|| undefined` is not incidental: `AvatarImage` treats an empty string as
 * a source and renders a broken image rather than falling back to the initials.
 */
export function UserAvatar({ user, className, fallbackClassName, alt }: UserAvatarProps) {
  const displayName = user?.name ?? null;

  return (
    <Avatar className={className}>
      <AvatarImage src={user?.image || undefined} alt={alt ?? displayName ?? ""} />
      <AvatarFallback className={cn("font-semibold", fallbackClassName)}>
        {initialsOf(displayName)}
      </AvatarFallback>
    </Avatar>
  );
}

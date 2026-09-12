import { sql } from "drizzle-orm";
import { moderationAction, post, user } from "@my-tuums/db/schema";

/**
 * Correlated expressions for a stored moderation_action row. Explicit outer
 * identifiers keep Drizzle's single-table projection mapping from stripping
 * the qualification and accidentally reading the inner table's columns.
 * Intake uses these in its conditional insert; review uses the same rules.
 */
export const moderationActionState = {
  recipientId: sql<string | null>`case when moderation_action.target_type = 'user'
    then moderation_action.target_user_id
    else (select ${post.authorId} from ${post}
      where ${post.id} = moderation_action.target_post_id) end`,
  current: sql<boolean>`case moderation_action.action
    when 'post_removed' then exists (select 1 from ${post}
      where ${post.id} = moderation_action.target_post_id and ${post.removedAt} is not null)
    when 'user_suspended' then exists (select 1 from ${user}
      where ${user.id} = moderation_action.target_user_id and ${user.banned} = 1
      and ${user.banExpires} > cast(unixepoch('subsec') * 1000 as integer))
    when 'user_banned' then exists (select 1 from ${user}
      where ${user.id} = moderation_action.target_user_id and ${user.banned} = 1
      and ${user.banExpires} is null)
    when 'role_changed' then exists (select 1 from ${user}
      where ${user.id} = moderation_action.target_user_id
      and json_type(moderation_action.details, '$.newRole') = 'text'
      and json_extract(moderation_action.details, '$.newRole') <> ''
      and ${user.role} = json_extract(moderation_action.details, '$.newRole'))
    else 0 end`.mapWith(Boolean),
  // Match the unused NULL key too, allowing one index seek through all three
  // target columns instead of scanning every action with the same target type.
  latest: sql<boolean>`not exists (select 1 from ${moderationAction} as newer_action
    where newer_action.target_type = moderation_action.target_type
      and newer_action.action = moderation_action.action
      and newer_action.target_post_id is moderation_action.target_post_id
      and newer_action.target_user_id is moderation_action.target_user_id
      and (newer_action.created_at, newer_action.id)
        > (moderation_action.created_at, moderation_action.id))`.mapWith(Boolean),
};

-- Keep direct writes and auth writes on the same canonical handle. SQLite
-- cannot assign NEW columns in a BEFORE trigger; the guarded AFTER trigger
-- changes them inside the original statement's atomic execution instead.
CREATE TRIGGER user_normalize_handle_insert
AFTER INSERT ON user
WHEN NEW.username IS NOT lower(NEW.username)
  OR NEW.display_username IS NOT lower(NEW.username)
BEGIN
  UPDATE user SET username = lower(NEW.username), display_username = lower(NEW.username)
  WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER user_normalize_handle_update
AFTER UPDATE OF username, display_username ON user
WHEN NEW.username IS NOT lower(NEW.username)
  OR NEW.display_username IS NOT lower(NEW.username)
BEGIN
  UPDATE user SET username = lower(NEW.username), display_username = lower(NEW.username)
  WHERE id = NEW.id;
END;

--> statement-breakpoint
CREATE INDEX game_popularity_idx ON game (coalesce(popularity_rank, 2147483647), igdb_id);
--> statement-breakpoint
CREATE INDEX game_year_idx ON game (coalesce(first_release_year, 0), igdb_id);

--> statement-breakpoint
-- Account deletion retains the former subtree-cascade semantics without one
-- recursive FK trigger per reply. Freeze the descendant set before deleting;
-- quotes are references, so another author's quoting post survives.
CREATE TRIGGER user_delete_post_tree
BEFORE DELETE ON user
BEGIN
  DELETE FROM post WHERE id IN (
    WITH RECURSIVE owned_tree(id) AS MATERIALIZED (
      SELECT id FROM post WHERE author_id = OLD.id
      UNION
      SELECT child.id FROM post AS child
      JOIN owned_tree ON child.parent_id = owned_tree.id
    )
    SELECT id FROM owned_tree
  );
END;

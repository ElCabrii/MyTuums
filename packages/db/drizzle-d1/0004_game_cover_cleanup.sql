CREATE TRIGGER game_cover_replaced AFTER UPDATE OF cover_media_path ON game
WHEN OLD.cover_media_path IS NOT NEW.cover_media_path AND OLD.cover_media_path IS NOT NULL
BEGIN
  INSERT INTO media_intent (id, scope, kind, paths, ready_at)
  VALUES (lower(hex(randomblob(16))), 'catalog', 'cleanup', json_array(OLD.cover_media_path),
    cast(unixepoch('subsec') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER game_cover_deleted BEFORE DELETE ON game
WHEN OLD.cover_media_path IS NOT NULL
BEGIN
  INSERT INTO media_intent (id, scope, kind, paths, ready_at)
  VALUES (lower(hex(randomblob(16))), 'catalog', 'cleanup', json_array(OLD.cover_media_path),
    cast(unixepoch('subsec') * 1000 as integer));
END;

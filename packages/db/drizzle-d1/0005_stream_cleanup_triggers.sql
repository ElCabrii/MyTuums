CREATE TRIGGER stream_video_cleanup AFTER UPDATE OF state, author_id, post_id ON video
WHEN NEW.stream_creator_id IS NOT NULL AND (
  NEW.author_id IS NULL OR NEW.state IN ('failed', 'cancelled', 'deleted')
  OR (OLD.state = 'published' AND NEW.post_id IS NULL)
)
BEGIN
  INSERT INTO video_cleanup (id, video_id, prefix, stream_uid)
  VALUES (lower(hex(randomblob(16))), NEW.id, 'stream-upload/' || NEW.id, NEW.stream_uid)
  ON CONFLICT(prefix) DO UPDATE SET stream_uid = coalesce(excluded.stream_uid, video_cleanup.stream_uid),
    next_attempt_at = cast(unixepoch('subsec') * 1000 as integer);
  UPDATE video SET upload_url = NULL WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER stream_video_deleted BEFORE DELETE ON video
WHEN OLD.stream_creator_id IS NOT NULL AND OLD.author_id IS NOT NULL
  AND OLD.state NOT IN ('failed', 'cancelled', 'deleted')
BEGIN
  INSERT INTO video_cleanup (id, video_id, prefix, stream_uid)
  VALUES (lower(hex(randomblob(16))), OLD.id, 'stream-upload/' || OLD.id, OLD.stream_uid)
  ON CONFLICT(prefix) DO UPDATE SET stream_uid = coalesce(excluded.stream_uid, video_cleanup.stream_uid),
    next_attempt_at = cast(unixepoch('subsec') * 1000 as integer);
END;

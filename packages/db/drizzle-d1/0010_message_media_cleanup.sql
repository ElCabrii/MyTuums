-- A message tombstone retains evidence. Hard deletion (including account
-- cascades) retires its storage through durable, owner-independent cleanup.
CREATE TRIGGER message_attachment_media_deleted BEFORE DELETE ON message_attachment
WHEN OLD.kind IN ('image', 'voice')
BEGIN
  INSERT INTO media_intent (id, scope, kind, paths, ready_at)
  VALUES (lower(hex(randomblob(16))), 'message:' || OLD.message_id, 'cleanup',
    json_array(OLD.media_path), cast(unixepoch('subsec') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER message_attachment_video_deleted BEFORE DELETE ON message_attachment
WHEN OLD.video_id IS NOT NULL
BEGIN
  UPDATE video SET state = 'deleted', upload_url = NULL WHERE id = OLD.video_id;
END;
--> statement-breakpoint
-- A published message video deliberately has no post_id. Only loss of an
-- existing post reference is a post orphan transition.
DROP TRIGGER stream_video_cleanup;
--> statement-breakpoint
CREATE TRIGGER stream_video_cleanup AFTER UPDATE OF state, author_id, post_id ON video
WHEN NEW.stream_creator_id IS NOT NULL AND (
  NEW.author_id IS NULL OR NEW.state IN ('failed', 'cancelled', 'deleted')
  OR (OLD.state = 'published' AND OLD.post_id IS NOT NULL AND NEW.post_id IS NULL)
)
BEGIN
  INSERT INTO video_cleanup (id, video_id, prefix, stream_uid)
  VALUES (lower(hex(randomblob(16))), NEW.id, 'stream-upload/' || NEW.id, NEW.stream_uid)
  ON CONFLICT(prefix) DO UPDATE SET stream_uid = coalesce(excluded.stream_uid, video_cleanup.stream_uid),
    next_attempt_at = cast(unixepoch('subsec') * 1000 as integer);
  UPDATE video SET upload_url = NULL WHERE id = NEW.id;
END;

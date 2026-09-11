-- Cleanup belongs to the database transition, including writes outside the upload handler.
CREATE TRIGGER user_media_replaced AFTER UPDATE OF image, image_original, banner_image, banner_image_original ON user
WHEN (OLD.image IS NOT NEW.image AND OLD.image LIKE '/media/%')
  OR (OLD.image_original IS NOT NEW.image_original AND OLD.image_original LIKE '/media/%')
  OR (OLD.banner_image IS NOT NEW.banner_image AND OLD.banner_image LIKE '/media/%')
  OR (OLD.banner_image_original IS NOT NEW.banner_image_original AND OLD.banner_image_original LIKE '/media/%')
BEGIN
  INSERT INTO media_intent (id, scope, kind, paths, ready_at)
  VALUES (lower(hex(randomblob(16))), 'profile:' || OLD.id, 'cleanup', json_array(
    CASE WHEN OLD.image IS NOT NEW.image THEN OLD.image END,
    CASE WHEN OLD.image_original IS NOT NEW.image_original THEN OLD.image_original END,
    CASE WHEN OLD.banner_image IS NOT NEW.banner_image THEN OLD.banner_image END,
    CASE WHEN OLD.banner_image_original IS NOT NEW.banner_image_original THEN OLD.banner_image_original END
  ), cast(unixepoch('subsec') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER user_media_deleted BEFORE DELETE ON user
WHEN OLD.image LIKE '/media/%' OR OLD.image_original LIKE '/media/%'
  OR OLD.banner_image LIKE '/media/%' OR OLD.banner_image_original LIKE '/media/%'
BEGIN
  INSERT INTO media_intent (id, scope, kind, paths, ready_at)
  VALUES (lower(hex(randomblob(16))), 'profile:' || OLD.id, 'cleanup',
    json_array(OLD.image, OLD.image_original, OLD.banner_image, OLD.banner_image_original),
    cast(unixepoch('subsec') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER link_card_media_replaced AFTER UPDATE OF image_media_path ON link_card
WHEN OLD.image_media_path IS NOT NEW.image_media_path AND OLD.image_media_path IS NOT NULL
BEGIN
  INSERT INTO media_intent (id, scope, kind, paths, ready_at)
  VALUES (lower(hex(randomblob(16))), 'link:' || OLD.url, 'cleanup', json_array(OLD.image_media_path),
    cast(unixepoch('subsec') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER link_card_media_deleted BEFORE DELETE ON link_card
WHEN OLD.image_media_path IS NOT NULL
BEGIN
  INSERT INTO media_intent (id, scope, kind, paths, ready_at)
  VALUES (lower(hex(randomblob(16))), 'link:' || OLD.url, 'cleanup', json_array(OLD.image_media_path),
    cast(unixepoch('subsec') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER post_attachment_media_deleted BEFORE DELETE ON post_attachment
WHEN OLD.video_id IS NULL
BEGIN
  INSERT INTO media_intent (id, scope, kind, paths, ready_at)
  VALUES (lower(hex(randomblob(16))), 'post:' || OLD.post_id, 'cleanup', json_array(OLD.media_path),
    cast(unixepoch('subsec') * 1000 as integer));
END;

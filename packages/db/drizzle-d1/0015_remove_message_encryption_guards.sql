-- Encryption never shipped to production. Discard its preview/test messages
-- before removing the envelope column; retain every earlier plaintext message.
-- Ordinary deletion keeps the attachment and Stream cleanup triggers active.
DELETE FROM conversation
WHERE EXISTS (SELECT 1 FROM message WHERE conversation_id = conversation.id AND envelope IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM message WHERE conversation_id = conversation.id AND envelope IS NULL);
--> statement-breakpoint
UPDATE conversation
SET last_message_at = (SELECT max(created_at) FROM message WHERE conversation_id = conversation.id AND envelope IS NULL)
WHERE EXISTS (SELECT 1 FROM message WHERE conversation_id = conversation.id AND envelope IS NOT NULL);
--> statement-breakpoint
DELETE FROM message WHERE envelope IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER message_require_encryption;
--> statement-breakpoint
DROP TRIGGER message_content_immutable;
--> statement-breakpoint
-- Content remains immutable; sender deletion changes only the tombstone.
CREATE TRIGGER message_content_immutable
BEFORE UPDATE OF body ON message
WHEN NEW.body IS NOT OLD.body
BEGIN
  SELECT RAISE(ABORT, 'Message content is immutable');
END;

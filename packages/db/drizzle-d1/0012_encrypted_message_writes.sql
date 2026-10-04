-- Legacy rows remain readable. Once this migration lands, even an old Worker
-- must fail closed instead of inserting plaintext during rollout or rollback.
CREATE TRIGGER message_require_encryption
BEFORE INSERT ON message
WHEN NEW.envelope IS NULL OR NEW.body != '[encrypted]' OR length(NEW.envelope) > 32768 OR NOT json_valid(NEW.envelope)
BEGIN
  SELECT RAISE(ABORT, 'New messages require encryption');
END;
--> statement-breakpoint
-- Message content is immutable; deletion changes only the tombstone timestamp.
CREATE TRIGGER message_content_immutable
BEFORE UPDATE OF body, envelope ON message
WHEN NEW.body IS NOT OLD.body OR NEW.envelope IS NOT OLD.envelope
BEGIN
  SELECT RAISE(ABORT, 'Message content is immutable');
END;

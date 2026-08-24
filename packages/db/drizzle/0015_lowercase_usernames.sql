-- The existing unique constraint is case-sensitive, so two legacy rows can
-- differ only by case. Refuse the migration before changing any row if such a
-- collision exists; resolving identities is an operator decision, not
-- something a data migration may guess at.
DO $$
BEGIN
	IF EXISTS (
		SELECT lower("username")
		FROM "user"
		WHERE "username" IS NOT NULL
		GROUP BY lower("username")
		HAVING count(DISTINCT "id") > 1
	) THEN
		RAISE EXCEPTION 'Cannot lowercase usernames: case-folded collisions require manual review.';
	END IF;
END
$$;
--> statement-breakpoint
-- Railway runs this migration while the previous application version can
-- still serve traffic. Install the invariant in Postgres before the backfill
-- so an old writer cannot recreate mixed-case display handles after its row
-- has been cleaned. Keeping the trigger also protects direct database writers
-- and makes username the sole source of truth for both columns.
CREATE FUNCTION "normalize_user_handle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."username" IS NULL THEN
		NEW."display_username" := NULL;
	ELSE
		NEW."username" := lower(NEW."username");
		NEW."display_username" := NEW."username";
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_normalize_handle_before_write"
BEFORE INSERT OR UPDATE OF "username", "display_username" ON "user"
FOR EACH ROW
EXECUTE FUNCTION "normalize_user_handle"();
--> statement-breakpoint
-- `username` is the canonical identity. Derive the display column from it so
-- every stored, session and public representation agrees, while accounts that
-- have not claimed a handle keep both fields null.
UPDATE "user"
SET
	"username" = lower("username"),
	"display_username" = lower("username")
WHERE "username" IS NOT NULL;
--> statement-breakpoint
UPDATE "user"
SET "display_username" = NULL
WHERE "username" IS NULL AND "display_username" IS NOT NULL;

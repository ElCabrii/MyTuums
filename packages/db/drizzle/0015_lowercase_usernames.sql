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

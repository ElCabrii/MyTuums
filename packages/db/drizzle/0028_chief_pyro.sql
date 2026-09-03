CREATE TABLE "user_badge" (
	"user_id" text NOT NULL,
	"badge" text NOT NULL,
	"earned_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_badge_user_id_badge_pk" PRIMARY KEY("user_id","badge"),
	CONSTRAINT "user_badge_badge" CHECK ("user_badge"."badge" in ('popular', 'rising_star', 'star', 'superstar', 'supernova', 'noticed', 'trendy', 'big', 'exploding', 'giant', 'founder', 'super_early_access', 'early_access'))
);
--> statement-breakpoint
ALTER TABLE "user_badge" ADD CONSTRAINT "user_badge_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Join-badge backfill (issue #308): the join badges are stamped at account
-- creation from now on (packages/db/src/stamp-join-badges.ts, wired into the
-- auth create hook), but accounts that already exist will never sign up
-- again — this is their only chance to earn what their creation rank owes
-- them. `rank() - 1` over `created_at` counts the accounts created strictly
-- before each row (accounts sharing an instant share a rank, the same tie
-- tolerance the stamping hook has), and the composite primary key makes the
-- insert idempotent against anything the hook may have written. One-time
-- cost on a pre-launch-sized user table.
INSERT INTO "user_badge" ("user_id", "badge")
SELECT "id", 'super_early_access'
FROM (
	SELECT "id", rank() OVER (ORDER BY "created_at") - 1 AS "preceding" FROM "user"
) "ranked"
WHERE "preceding" < 50
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "user_badge" ("user_id", "badge")
SELECT "id", 'early_access'
FROM (
	SELECT "id", rank() OVER (ORDER BY "created_at") - 1 AS "preceding" FROM "user"
) "ranked"
WHERE "preceding" < 1000
ON CONFLICT DO NOTHING;
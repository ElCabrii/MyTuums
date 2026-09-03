CREATE TABLE "user_badge" (
	"user_id" text NOT NULL,
	"badge" text NOT NULL,
	"earned_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_badge_user_id_badge_pk" PRIMARY KEY("user_id","badge"),
	CONSTRAINT "user_badge_badge" CHECK ("user_badge"."badge" in ('noticed', 'trendy', 'big', 'exploding', 'giant', 'founder'))
);
--> statement-breakpoint
ALTER TABLE "user_badge" ADD CONSTRAINT "user_badge_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- The join badges derive from an account's creation rank — a correlated
-- count of users created strictly before it, on every profile read
-- (packages/api/src/users.ts). This index backs that count. It lives only in
-- migration SQL, never in src/schema/auth.ts: that file is regenerated
-- wholesale by db:generate:auth, so anything hand-written there is destroyed.
-- The migration chain never drops objects absent from the drizzle snapshots,
-- so the index survives every later regeneration — the same arrangement
-- migration 0015's normalize_user_handle trigger has.
CREATE INDEX "user_created_at_idx" ON "user" USING btree ("created_at");

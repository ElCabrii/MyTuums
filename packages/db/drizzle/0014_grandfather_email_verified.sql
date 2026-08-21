-- Grandfather existing accounts as email-verified so the
-- `requireEmailVerification: true` flip (issue #172) does not lock them out.
-- Every existing account predates verification being enforced, so the column
-- (which defaults to false) is false for all of them. This is a one-time data
-- backfill, not a schema change: the `email_verified` column already exists.
-- New password sign-ups still verify through the normal email-link flow.
UPDATE "user" SET "email_verified" = true;
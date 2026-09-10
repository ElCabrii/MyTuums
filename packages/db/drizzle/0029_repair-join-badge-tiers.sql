-- Repairs the join-badge rows on every database that ran migration 0028 as
-- first shipped (issue #308): that backfill stamped BOTH join badges for the
-- first 50 accounts, before the tiers-become-exclusive rectification — an
-- account must carry the higher of what its rank earned, never both.
--
-- 0028 is restored to its shipped bytes rather than edited, because a
-- migration file must never change once applied (drizzle-kit tracks the
-- hash): every database therefore runs the same 0028 — stamping both tiers
-- for the first 50 — and this migration converges them all, old and fresh
-- alike, to the exclusive form the sign-up hook now stamps.
--
-- Idempotent by construction: with no account holding both tiers it deletes
-- nothing. The tiered families (followers, post-likes) need no equivalent
-- repair — their accumulate-semantics window lasted hours on a pre-launch
-- app whose thresholds are 1,001+ followers or likes, no account crossed
-- one, and a residual stack would be display-invisible anyway (the display
-- set takes the family's highest stamped tier) and self-heal on the next
-- upgrade.
DELETE FROM "user_badge"
WHERE "badge" = 'early_access'
	AND "user_id" IN (
		SELECT "user_id" FROM "user_badge" WHERE "badge" = 'super_early_access'
	);

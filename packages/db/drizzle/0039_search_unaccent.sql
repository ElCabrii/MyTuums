-- Accent-insensitive search: typing "pokemon" must find "Pokémon".
--
-- `unaccent` is a trusted extension (installable by the database owner on
-- managed platforms, no superuser required), but its `unaccent(text)`
-- shorthand is STABLE — the dictionary it resolves is a replaceable object —
-- which forbids using it inside expression indexes. The wrapper below pins
-- the dictionary reference, making the fold IMMUTABLE: today's ILIKE scans
-- call one stable name, and a future pg_trgm/expression index over
-- `search_unaccent(col)` stays possible without another migration.
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE FUNCTION search_unaccent(value text) RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  STRICT
AS $$
  SELECT unaccent('public.unaccent'::regdictionary, value)
$$;

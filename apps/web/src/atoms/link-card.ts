import { atomFamily } from "jotai-family";
import { atomWithQuery } from "jotai-tanstack-query";
import { linkCardQueryOptions } from "@/lib/query-definitions";

/**
 * One query atom per previewed URL, shared by every post carrying it (issue
 * #260). Keyed on the normalized `href` string the linkifier produced, so two
 * cards over the same address share one observer — the same structural-dedup
 * reasoning as `postFeedFamily`, on the one primitive shape the family rules
 * allow.
 *
 * Deliberately not part of the sign-out sweep (`session-teardown.ts`): a card
 * is a property of the URL, not of the viewer — no field in it is
 * viewer-relative, so nothing here can go stale across accounts. The
 * QueryClient clear on sign-out already drops the cached rows; the family's
 * entries simply refill on the next signed-in view.
 */
const linkCardFamily = atomFamily((url: string) => atomWithQuery(() => linkCardQueryOptions(url)));

/** The query state for one URL's preview card; components read this, not the family. */
export const linkCardAtom = (url: string) => linkCardFamily(url);

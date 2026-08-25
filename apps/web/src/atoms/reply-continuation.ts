import { atomFamily } from "jotai-family";
import { atomWithInfiniteQuery } from "jotai-tanstack-query";
import { replyContinuationQueryOptions } from "@/lib/query-definitions";

function encode(rootPostId: string, cursor: string): string {
  return `${rootPostId}|${cursor}`;
}

function decode(key: string) {
  const separator = key.indexOf("|");
  return {
    rootPostId: key.slice(0, separator),
    cursor: key.slice(separator + 1),
  };
}

const replyContinuationFamily = atomFamily((key: string) => {
  const { rootPostId, cursor } = decode(key);
  return atomWithInfiniteQuery(() => replyContinuationQueryOptions(rootPostId, cursor));
});

/** Additional pages for one inline original-author reply branch. */
export function replyContinuationAtom(rootPostId: string, cursor: string) {
  return replyContinuationFamily(encode(rootPostId, cursor));
}

/** Drops every viewer-relative continuation observer after sign-out. */
export function clearReplyContinuationFamily(): void {
  for (const key of replyContinuationFamily.getParams()) replyContinuationFamily.remove(key);
}

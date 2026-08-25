/** The post-tree fields needed to choose one deterministic inline continuation. */
export interface ReplyBranchNode {
  id: string;
  parentId: string;
  authorId: string;
  createdAt: Date;
}

function comparePosts(a: ReplyBranchNode, b: ReplyBranchNode): number {
  const time = a.createdAt.getTime() - b.createdAt.getTime();
  if (time !== 0) return time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Selects the one linear descendant branch rendered beneath a direct reply.
 *
 * The first post by the focused post's author chooses the branch. Its ancestor
 * path is included so a reply several levels down never appears detached from
 * the exchange that led to it. From that post onward, the oldest child (with
 * id as a stable tie-breaker) is followed until the branch ends. This keeps the
 * result chronological and deterministic without ranking participants or
 * expanding sibling conversations.
 */
export function selectReplyBranch(
  rootPostId: string,
  focusedAuthorId: string,
  descendants: readonly ReplyBranchNode[],
): ReplyBranchNode[] {
  const byId = new Map(descendants.map((node) => [node.id, node]));
  const joiningPost = descendants
    .filter((node) => node.authorId === focusedAuthorId)
    .sort(comparePosts)[0];

  if (!joiningPost) return [];

  const reversedPath: ReplyBranchNode[] = [];
  const pathIds = new Set<string>();
  let current: ReplyBranchNode | undefined = joiningPost;

  while (current) {
    if (pathIds.has(current.id)) return [];
    pathIds.add(current.id);
    reversedPath.push(current);

    if (current.parentId === rootPostId) break;
    current = byId.get(current.parentId);
  }

  if (reversedPath.at(-1)?.parentId !== rootPostId) return [];

  const branch = reversedPath.reverse();
  const children = new Map<string, ReplyBranchNode[]>();
  for (const node of descendants) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(comparePosts);

  current = joiningPost;
  while (current) {
    const child: ReplyBranchNode | undefined = children.get(current.id)?.[0];
    if (!child || pathIds.has(child.id)) break;
    pathIds.add(child.id);
    branch.push(child);
    current = child;
  }

  return branch;
}

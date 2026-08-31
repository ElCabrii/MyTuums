import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { renderWithProviders } from "@/test/render";
import { installTestOrpc, type LinkCard } from "@/lib/orpc";
import { linkCardQueryOptions } from "@/lib/query-definitions";
import { PostLinkCard } from "@/components/post-link-card";

// The card component never calls the transport in these tests: the query's
// answer is seeded straight into the cache, which is the only thing the
// component reads. `linkCard` exists on the fake so the query *key* can be
// derived the same way production derives it.
const fakeClient = {
  post: {
    linkCard: vi.fn(() => Promise.resolve({ card: null })),
    list: vi.fn(),
    thread: vi.fn(),
  },
  search: { users: vi.fn(), posts: vi.fn() },
  user: { byUsername: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

const URL = "https://example.com/articles/1";

/** Seeds the query cache with the procedure's `{ card }` answer shape. */
function seedCard(queryClient: QueryClient, answer: { card: LinkCard | null }): void {
  // The options helper's own key, same as `query-fixtures.ts`: it carries the
  // query-type marker the atom's observer reads under.
  queryClient.setQueryData(linkCardQueryOptions(URL).queryKey, answer);
}

describe("PostLinkCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the card's domain, title, description and stored lead image", async () => {
    const queryClient = new QueryClient();
    seedCard(queryClient, {
      card: {
        url: URL,
        domain: "Example Weekly",
        title: "A very good article",
        description: "What it is about",
        imageUrl: "/media/link-cards/11111111-1111-4111-8111-111111111111.png",
      },
    });

    await renderWithProviders(<PostLinkCard url={URL} />, { queryClient, signedInAs: true });

    const card = screen.getByRole("link", { name: /A very good article/ });
    expect(card).toHaveAttribute("href", URL);
    expect(card).toHaveAttribute("target", "_blank");
    expect(card).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
    expect(card).toHaveTextContent("Example Weekly");
    expect(card).toHaveTextContent("What it is about");
    // The lead image is decorative (its description is the title beside it),
    // so it is located structurally rather than by role.
    const image = card.querySelector("img");
    expect(image).toHaveAttribute(
      "src",
      "/media/link-cards/11111111-1111-4111-8111-111111111111.png",
    );
    expect(image).toHaveAttribute("alt", "");
  });

  it("renders nothing when the URL has no card — the plain link stands in", async () => {
    const queryClient = new QueryClient();
    seedCard(queryClient, { card: null });

    const { container } = await renderWithProviders(<PostLinkCard url={URL} />, {
      queryClient,
      signedInAs: true,
    });

    await waitFor(() => expect(screen.queryByRole("link")).not.toBeInTheDocument());
    expect(container.querySelector("img")).toBeNull();
  });
});

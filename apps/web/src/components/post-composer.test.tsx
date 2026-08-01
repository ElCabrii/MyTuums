import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { POST_MAX_LENGTH } from "@my-tuums/api/constants";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    post: { list: vi.fn(), like: vi.fn(), unlike: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/orpc", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { orpc: createTanstackQueryUtils(clientMock) };
});

const { sessionMock } = vi.hoisted(() => {
  const sessionMock: {
    current: { user: { id: string; name: string; image: string | null } } | null;
  } = { current: { user: { id: "viewer-1", name: "Alex Mercer", image: null } } };
  return { sessionMock };
});

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: sessionMock.current, isPending: false }),
}));

const { PostComposer } = await import("./post-composer");

function renderComposer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <PostComposer />
    </QueryClientProvider>,
  );

  return { user: userEvent.setup(), queryClient };
}

const textarea = () => screen.getByRole("textbox");
const submit = () => screen.getByRole("button", { name: /post/i });

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.current = { user: { id: "viewer-1", name: "Alex Mercer", image: null } };
  clientMock.post.create.mockResolvedValue({ id: "post-1", content: "hello" });
});

describe("PostComposer", () => {
  it("renders nothing for a signed-out visitor", () => {
    sessionMock.current = null;

    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <PostComposer />
      </QueryClientProvider>,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("counts down the characters left", async () => {
    const { user } = renderComposer();

    expect(screen.getByText(String(POST_MAX_LENGTH))).toBeInTheDocument();
    await user.type(textarea(), "hello");
    expect(screen.getByText(String(POST_MAX_LENGTH - 5))).toBeInTheDocument();
  });

  it("won't submit an empty or whitespace-only post", async () => {
    const { user } = renderComposer();

    expect(submit()).toBeDisabled();

    await user.type(textarea(), "   ");
    expect(submit()).toBeDisabled();

    await user.type(textarea(), "x");
    expect(submit()).toBeEnabled();
  });

  it("won't submit past the length limit", async () => {
    const { user } = renderComposer();

    // `paste` rather than `type`, which would be one event per character.
    await user.click(textarea());
    await user.paste("x".repeat(POST_MAX_LENGTH + 1));

    expect(screen.getByText("-1")).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    expect(clientMock.post.create).not.toHaveBeenCalled();
  });

  it("sends the trimmed content and clears the box", async () => {
    const { user } = renderComposer();

    await user.type(textarea(), "  first light  ");
    await user.click(submit());

    await waitFor(() => {
      expect(clientMock.post.create).toHaveBeenCalledWith(
        { content: "first light" },
        expect.anything(),
      );
    });
    await waitFor(() => {
      expect(textarea()).toHaveValue("");
    });
  });

  it("refetches the feeds so the new post appears in them", async () => {
    const { user, queryClient } = renderComposer();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.type(textarea(), "new post");
    await user.click(submit());

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
  });

  it("keeps the draft and explains itself when publishing fails", async () => {
    clientMock.post.create.mockRejectedValue(new Error("server said no"));

    const { user } = renderComposer();
    await user.type(textarea(), "worth keeping");
    await user.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent("server said no");
    expect(textarea()).toHaveValue("worth keeping");
  });
});

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SearchPage } from "@/components/search-page";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/search")({
  head: () => pageHead(m.search_input_aria()),
  component: SearchPage,
  /**
   * `q` arrives from *outside* — the header's search box navigates here with
   * whatever was typed into it — so it is narrowed to a string rather than
   * trusted: anything that isn't a string is dropped, and the page renders
   * its "type something" prompt instead of a raw value.
   */
  validateSearch: (search) => {
    const parsed = searchPageSchema.parse(search);
    return parsed.q ? { q: parsed.q } : {};
  },
});

const searchPageSchema = z.object({ q: z.string().trim().optional() });

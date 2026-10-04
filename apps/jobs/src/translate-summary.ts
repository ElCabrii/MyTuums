const MAX_CHUNK_LENGTH = 300;
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/** m2m100 silently truncates long output; preserve every source chunk and paragraph. */
export async function translateGameSummary(
  text: string,
  translateChunk: (text: string) => Promise<string>,
) {
  const paragraphs = text.trim().split(/\n\s*\n/);
  const translated = await Promise.all(
    paragraphs.map(async (paragraph) => {
      const chunks: string[] = [];
      for (const sentence of sentences.segment(paragraph)) {
        let remaining = sentence.segment.trim();
        while (remaining.length > MAX_CHUNK_LENGTH) {
          const wordEnd = remaining.slice(0, MAX_CHUNK_LENGTH + 1).lastIndexOf(" ");
          const end = wordEnd > 0 ? wordEnd : MAX_CHUNK_LENGTH;
          chunks.push(remaining.slice(0, end));
          remaining = remaining.slice(end).trimStart();
        }
        if (remaining) chunks.push(remaining);
      }
      const results = await Promise.all(
        chunks.map(async (chunk) => {
          const result = (await translateChunk(chunk)).trim();
          if (!result) throw new Error("Empty translation chunk.");
          return result;
        }),
      );
      return results.join(" ");
    }),
  );
  return translated.join("\n\n");
}

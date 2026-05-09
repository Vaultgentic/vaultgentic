import { describe, expect, it } from "vitest";
import { chunkMarkdownNote, parseMarkdownNote } from "./markdown.js";

describe("GIVEN Markdown note parsing", () => {
  describe("WHEN a note has frontmatter metadata", () => {
    describe("THEN metadata is extracted and normalized", () => {
      it("SHOULD return title, frontmatter, aliases, and tags", () => {
        const note = parseMarkdownNote({
          path: "folder/source.md",
          content: `---
title: Source Title
aliases:
  - Source
  - "Alias Two"
tags:
  - "#project"
  - nested/tag
---
# Heading
Body with #inline-tag and #nested/inline.
`,
        });

        expect(note.title).toBe("Source Title");
        expect(note.frontmatter).toMatchObject({
          title: "Source Title",
          aliases: ["Source", "Alias Two"],
          tags: ["#project", "nested/tag"],
        });
        expect(note.aliases).toEqual(["Source", "Alias Two"]);
        expect(note.tags).toEqual([
          "project",
          "nested/tag",
          "inline-tag",
          "nested/inline",
        ]);
      });
    });
  });

  describe("WHEN frontmatter uses singular strings", () => {
    describe("THEN aliases and tags are still extracted", () => {
      it("SHOULD support alias and tag string fields", () => {
        const note = parseMarkdownNote({
          path: "strings.md",
          content: `---
alias: Single Alias
tag: "#one two,three"
---
Body
`,
        });

        expect(note.aliases).toEqual(["Single Alias"]);
        expect(note.tags).toEqual(["one", "two", "three"]);
      });
    });
  });

  describe("WHEN a note has no frontmatter title", () => {
    describe("THEN the title falls back to the filename", () => {
      it("SHOULD derive title from basename without extension", () => {
        const note = parseMarkdownNote({
          path: "folder/My Note.md",
          content: "# Heading\nBody",
        });

        expect(note.title).toBe("My Note");
        expect(note.frontmatter).toEqual({});
      });
    });
  });

  describe("WHEN a note has headings", () => {
    describe("THEN heading depth, text, and line are returned", () => {
      it("SHOULD collect ATX headings after frontmatter", () => {
        const note = parseMarkdownNote({
          path: "headings.md",
          content: `---
title: Headings
---
# First
Text
### Third ###
`,
        });

        expect(note.headings).toEqual([
          { depth: 1, text: "First", line: 4 },
          { depth: 3, text: "Third", line: 6 },
        ]);
      });

      it("SHOULD collect headings indented up to three spaces", () => {
        const note = parseMarkdownNote({
          path: "indented-heading.md",
          content: "   ## Indented\n",
        });

        expect(note.headings).toEqual([
          { depth: 2, text: "Indented", line: 1 },
        ]);
      });

      it("SHOULD preserve heading text that ends with a hash character", () => {
        const note = parseMarkdownNote({
          path: "hash-heading.md",
          content: "# C#\n## Trim closing hashes ##\n",
        });

        expect(note.headings).toEqual([
          { depth: 1, text: "C#", line: 1 },
          { depth: 2, text: "Trim closing hashes", line: 2 },
        ]);
      });
    });
  });

  describe("WHEN a note has wikilinks and embeds", () => {
    describe("THEN outgoing wiki links are collected", () => {
      it("SHOULD collect raw targets, aliases, and embed state", () => {
        const note = parseMarkdownNote({
          path: "links.md",
          content:
            "See [[Target Note|display text]], [[Plain]], and ![[image.png]].",
        });

        expect(note.links).toEqual([
          {
            target: "Target Note",
            alias: "display text",
            embedded: false,
            raw: "[[Target Note|display text]]",
          },
          {
            target: "Plain",
            alias: undefined,
            embedded: false,
            raw: "[[Plain]]",
          },
          {
            target: "image.png",
            alias: undefined,
            embedded: true,
            raw: "![[image.png]]",
          },
        ]);
      });
    });
  });

  describe("WHEN a note has a fenced code block", () => {
    describe("THEN code remains searchable in the body", () => {
      it("SHOULD preserve code block content", () => {
        const note = parseMarkdownNote({
          path: "code.md",
          content: `# Code

\`\`\`ts
const searchable = "inside code";
\`\`\`
`,
        });

        expect(note.bodyText).toContain("const searchable");
        expect(note.bodyText).toContain("inside code");
      });

      it("SHOULD not extract metadata-like syntax from code fences", () => {
        const note = parseMarkdownNote({
          path: "code-metadata.md",
          content: `# Real Heading
#real-tag [[Real Link]]

\`\`\`md
# Fake Heading
#fake-tag [[Fake Link]]
\`\`\`
`,
        });

        expect(note.bodyText).toContain("#fake-tag [[Fake Link]]");
        expect(note.tags).toEqual(["real-tag"]);
        expect(note.links.map((link) => link.target)).toEqual(["Real Link"]);
        expect(note.headings).toEqual([
          { depth: 1, text: "Real Heading", line: 1 },
        ]);
      });

      it("SHOULD not close fences with trailing info text", () => {
        const note = parseMarkdownNote({
          path: "nested-fence.md",
          content: `~~~md
\`\`\`ts
#fake-tag [[Fake Link]]
~~~
#real-tag [[Real Link]]
`,
        });

        expect(note.tags).toEqual(["real-tag"]);
        expect(note.links.map((link) => link.target)).toEqual(["Real Link"]);
      });
    });
  });

  describe("WHEN a note has inline code", () => {
    describe("THEN inline code remains searchable without metadata extraction", () => {
      it("SHOULD not extract tags or links from inline code spans", () => {
        const note = parseMarkdownNote({
          path: "inline-code.md",
          content:
            "Real #real-tag [[Real Link]] and `fake #fake-tag [[Fake Link]]`.",
        });

        expect(note.bodyText).toContain("#fake-tag [[Fake Link]]");
        expect(note.tags).toEqual(["real-tag"]);
        expect(note.links.map((link) => link.target)).toEqual(["Real Link"]);
      });
    });
  });

  describe("WHEN frontmatter is malformed", () => {
    describe("THEN parsing remains lenient for indexing", () => {
      it("SHOULD keep content searchable and use filename title", () => {
        const content = `---
title: [
---
# Still Searchable
`;

        const note = parseMarkdownNote({ path: "broken.md", content });

        expect(note.frontmatter).toEqual({});
        expect(note.title).toBe("broken");
        expect(note.bodyText).toBe(content);
        expect(note.headings).toEqual([
          { depth: 1, text: "Still Searchable", line: 4 },
        ]);
      });
    });
  });

  describe("WHEN a parsed note is chunked", () => {
    describe("THEN chunks preserve compact retrieval context", () => {
      it("SHOULD include metadata, nested headings, line metadata, and stable hashes", () => {
        const note = parseMarkdownNote({
          path: "folder/source.md",
          content: `---
title: Source Title
tags:
  - agent/search
---
# Parent
Parent body.

## Child
Child body with #inline-tag.
`,
        });

        const chunks = chunkMarkdownNote(note);
        const childChunk = chunks.find((chunk) =>
          chunk.headingPath.includes("Child"),
        );

        expect(childChunk).toMatchObject({
          path: "folder/source.md",
          title: "Source Title",
          headingPath: ["Parent", "Child"],
          index: 1,
          start_line: 9,
          end_line: 10,
        });
        expect(childChunk?.text).toContain("Title: Source Title");
        expect(childChunk?.text).toContain("Path: folder/source.md");
        expect(childChunk?.text).toContain("Headings: Parent > Child");
        expect(childChunk?.text).toContain("Tags: agent/search, inline-tag");
        expect(childChunk?.text).toContain("Child body with #inline-tag.");
        expect(childChunk?.content_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(chunkMarkdownNote(note)).toEqual(chunks);
      });

      it("SHOULD split long text into smaller agent-readable chunks with overlap", () => {
        const longText = "a".repeat(5000);
        const note = parseMarkdownNote({
          path: "long.md",
          content: longText,
        });

        const chunks = chunkMarkdownNote(note);
        const firstBody = readChunkBody(chunks[0].text);
        const secondBody = readChunkBody(chunks[1].text);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => chunk.text.length <= 2400)).toBe(true);
        expect(secondBody.startsWith(firstBody.slice(-220))).toBe(true);
        expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
      });

      it("SHOULD create a metadata chunk for frontmatter-only notes", () => {
        const note = parseMarkdownNote({
          path: "metadata.md",
          content: `---
title: Metadata Only
tags:
  - context
---
`,
        });

        const chunks = chunkMarkdownNote(note);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toMatchObject({
          path: "metadata.md",
          title: "Metadata Only",
          headingPath: [],
          index: 0,
          start_line: 6,
          end_line: 6,
        });
        expect(chunks[0].text).toBe(
          "Title: Metadata Only\nPath: metadata.md\nTags: context",
        );
      });

      it("SHOULD keep chunks below the max size when metadata is long", () => {
        const note = parseMarkdownNote({
          path: `${"deep/".repeat(200)}metadata.md`,
          content: `---
title: ${"Long Title ".repeat(500)}
tags:
  - ${"long-tag".repeat(500)}
---
`,
        });

        const chunks = chunkMarkdownNote(note);

        expect(chunks).toHaveLength(1);
        expect(chunks[0].text.length).toBeLessThanOrEqual(2400);
      });
    });
  });
});

function readChunkBody(text: string): string {
  return text.split("\n\n").slice(1).join("\n\n");
}

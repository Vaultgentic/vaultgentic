import { describe, expect, test } from "vitest";
import { parseMarkdownNote } from "./markdown.js";

describe("GIVEN Markdown note parsing", () => {
  describe("WHEN a note has frontmatter metadata", () => {
    describe("THEN metadata is extracted and normalized", () => {
      test("SHOULD return title, frontmatter, aliases, and tags", () => {
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
      test("SHOULD support alias and tag string fields", () => {
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
      test("SHOULD derive title from basename without extension", () => {
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
      test("SHOULD collect ATX headings after frontmatter", () => {
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

      test("SHOULD collect headings indented up to three spaces", () => {
        const note = parseMarkdownNote({
          path: "indented-heading.md",
          content: "   ## Indented\n",
        });

        expect(note.headings).toEqual([
          { depth: 2, text: "Indented", line: 1 },
        ]);
      });

      test("SHOULD preserve heading text that ends with a hash character", () => {
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
      test("SHOULD collect raw targets, aliases, and embed state", () => {
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
      test("SHOULD preserve code block content", () => {
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

      test("SHOULD not extract metadata-like syntax from code fences", () => {
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

      test("SHOULD not close fences with trailing info text", () => {
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
      test("SHOULD not extract tags or links from inline code spans", () => {
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
      test("SHOULD keep content searchable and use filename title", () => {
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
});

import matter from "gray-matter";
import path from "node:path";

export type ParsedMarkdownNote = {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  aliases: string[];
  tags: string[];
  links: WikiLink[];
  headings: MarkdownHeading[];
  bodyText: string;
};

export type WikiLink = {
  target: string;
  alias?: string;
  embedded: boolean;
  raw: string;
};

export type MarkdownHeading = {
  depth: number;
  text: string;
  line: number;
};

export function parseMarkdownNote(input: {
  path: string;
  content: string;
}): ParsedMarkdownNote {
  const parsedMatter = parseFrontmatter(input.content);
  const frontmatter = parsedMatter.frontmatter;
  const bodyText = parsedMatter.bodyText;
  const metadataText = stripInlineCode(stripFencedCode(bodyText));

  return {
    path: input.path,
    title: readTitle(frontmatter, input.path),
    frontmatter,
    aliases: readAliases(frontmatter),
    tags: readTags(frontmatter, metadataText),
    links: readLinks(metadataText),
    headings: readHeadings(metadataText, parsedMatter.bodyStartLine),
    bodyText,
  };
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  bodyText: string;
  bodyStartLine: number;
} {
  try {
    const parsed = matter(content);
    return {
      frontmatter: isRecord(parsed.data) ? parsed.data : {},
      bodyText: parsed.content,
      bodyStartLine: findBodyStartLine(content),
    };
  } catch {
    return { frontmatter: {}, bodyText: content, bodyStartLine: 1 };
  }
}

function findBodyStartLine(content: string): number {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    return 1;
  }

  const closingLineIndex = lines.findIndex(
    (line, index) => index > 0 && (line === "---" || line === "..."),
  );

  return closingLineIndex === -1 ? 1 : closingLineIndex + 2;
}

function readTitle(
  frontmatter: Record<string, unknown>,
  notePath: string,
): string {
  if (
    typeof frontmatter.title === "string" &&
    frontmatter.title.trim() !== ""
  ) {
    return frontmatter.title.trim();
  }

  return path.basename(notePath, path.extname(notePath));
}

function readAliases(frontmatter: Record<string, unknown>): string[] {
  return uniqueStrings([
    ...readStringValues(frontmatter.aliases, { splitString: false }),
    ...readStringValues(frontmatter.alias, { splitString: false }),
  ]);
}

function readTags(
  frontmatter: Record<string, unknown>,
  bodyText: string,
): string[] {
  return uniqueStrings([
    ...readStringValues(frontmatter.tags, { splitString: true }).map(
      normalizeTag,
    ),
    ...readStringValues(frontmatter.tag, { splitString: true }).map(
      normalizeTag,
    ),
    ...readInlineTags(bodyText),
  ]);
}

function readStringValues(
  value: unknown,
  options: { splitString: boolean },
): string[] {
  if (typeof value === "string") {
    const values = options.splitString ? value.split(/[\s,]+/) : [value];
    return cleanStrings(values);
  }

  if (Array.isArray(value)) {
    return cleanStrings(value.filter((entry) => typeof entry === "string"));
  }

  return [];
}

function readInlineTags(bodyText: string): string[] {
  const tags: string[] = [];
  const tagPattern = /(^|[\s([{])#([A-Za-z0-9][A-Za-z0-9/_-]*)/g;

  for (const match of bodyText.matchAll(tagPattern)) {
    const tag = match[2];
    if (tag !== undefined) {
      tags.push(tag);
    }
  }

  return tags;
}

function readLinks(bodyText: string): WikiLink[] {
  const links: WikiLink[] = [];
  const linkPattern = /(!?)\[\[([^\]\n]+)\]\]/g;

  for (const match of bodyText.matchAll(linkPattern)) {
    const raw = match[0];
    const targetAndAlias = match[2];
    if (targetAndAlias === undefined) {
      continue;
    }

    const [target, alias] = targetAndAlias
      .split("|", 2)
      .map((part) => part.trim());
    if (target === undefined || target === "") {
      continue;
    }

    links.push({
      target,
      alias: alias === undefined || alias === "" ? undefined : alias,
      embedded: match[1] === "!",
      raw,
    });
  }

  return links;
}

function stripFencedCode(bodyText: string): string {
  const lines = bodyText.split(/\r?\n/);
  let fence: { marker: "`" | "~"; length: number } | undefined;

  return lines
    .map((line) => {
      if (fence !== undefined) {
        const closingFenceMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (isMatchingFence(closingFenceMatch?.[1], fence)) {
          fence = undefined;
        }
        return "";
      }

      const openingFenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      const openingFence = openingFenceMatch?.[1];
      if (openingFence !== undefined) {
        const marker = openingFence[0] === "`" ? "`" : "~";
        fence = { marker, length: openingFence.length };
        return "";
      }

      return line;
    })
    .join("\n");
}

function stripInlineCode(bodyText: string): string {
  return bodyText
    .split("\n")
    .map((line) => {
      let strippedLine = "";
      let index = 0;

      while (index < line.length) {
        if (line[index] !== "`") {
          strippedLine += line[index];
          index += 1;
          continue;
        }

        const markerLength = countBackticks(line, index);
        const closingIndex = line.indexOf(
          "`".repeat(markerLength),
          index + markerLength,
        );
        if (closingIndex === -1) {
          strippedLine += line[index];
          index += 1;
          continue;
        }

        index = closingIndex + markerLength;
      }

      return strippedLine;
    })
    .join("\n");
}

function countBackticks(line: string, startIndex: number): number {
  let length = 0;
  while (line[startIndex + length] === "`") {
    length += 1;
  }

  return length;
}

function isMatchingFence(
  marker: string | undefined,
  fence: { marker: "`" | "~"; length: number },
): boolean {
  return (
    marker !== undefined &&
    marker[0] === fence.marker &&
    marker.length >= fence.length
  );
}

function readHeadings(
  bodyText: string,
  bodyStartLine: number,
): MarkdownHeading[] {
  return bodyText.split(/\r?\n/).flatMap((line, index) => {
    const match = /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match === null) {
      return [];
    }

    return [
      {
        depth: match[1].length,
        text: match[2].replace(/\s+#+\s*$/, "").trim(),
        line: bodyStartLine + index,
      },
    ];
  });
}

function normalizeTag(tag: string): string {
  return tag.replace(/^#+/, "");
}

function cleanStrings(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(cleanStrings(values))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

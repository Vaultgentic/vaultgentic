import matter from "gray-matter";
import { createHash } from "node:crypto";
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
  bodyStartLine: number;
};

export type MarkdownChunk = {
  path: string;
  title: string;
  headingPath: string[];
  text: string;
  content_hash: string;
  index: number;
  start_line?: number;
  end_line?: number;
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

type ChunkDraft = Omit<MarkdownChunk, "content_hash" | "index">;

type HeadingSection = {
  headingPath: string[];
  lines: string[];
  startLine: number;
  endLine: number;
};

type Paragraph = {
  text: string;
  startLine: number;
  endLine: number;
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
    bodyStartLine: parsedMatter.bodyStartLine,
  };
}

const targetChunkLength = 1600;
const maxChunkLength = 2400;
const overlapLength = 220;

export function chunkMarkdownNote(note: ParsedMarkdownNote): MarkdownChunk[] {
  return buildHeadingSections(note)
    .flatMap((section) => splitSection(note, section))
    .map((chunk, index) => ({
      ...chunk,
      index,
      content_hash: hashChunk(chunk.text),
    }));
}

function buildHeadingSections(note: ParsedMarkdownNote): HeadingSection[] {
  const bodyLines = note.bodyText.split(/\r?\n/);
  const headingsByLine = new Map(
    note.headings.map((heading) => [heading.line, heading]),
  );
  const sections: HeadingSection[] = [];
  const headingStack: MarkdownHeading[] = [];
  let current: HeadingSection | undefined;

  for (const [index, line] of bodyLines.entries()) {
    const lineNumber = note.bodyStartLine + index;
    const heading = headingsByLine.get(lineNumber);

    if (heading !== undefined) {
      if (current !== undefined && hasMeaningfulSectionText(current)) {
        sections.push(current);
      }

      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].depth >= heading.depth
      ) {
        headingStack.pop();
      }
      headingStack.push(heading);

      current = {
        headingPath: headingStack.map((entry) => entry.text),
        lines: [line],
        startLine: lineNumber,
        endLine: lineNumber,
      };
      continue;
    }

    if (current === undefined) {
      current = {
        headingPath: [],
        lines: [],
        startLine: lineNumber,
        endLine: lineNumber,
      };
    }

    current.lines.push(line);
    current.endLine = lineNumber;
  }

  if (current !== undefined && hasMeaningfulSectionText(current)) {
    sections.push(current);
  }

  return sections;
}

function splitSection(
  note: ParsedMarkdownNote,
  section: HeadingSection,
): ChunkDraft[] {
  const maxBodyLength = maxChunkLength;
  const targetBodyLength = targetChunkLength;
  const paragraphs = splitParagraphs(section);
  const chunks: ChunkDraft[] = [];
  let currentText = "";
  let currentStartLine = section.startLine;
  let currentEndLine = section.startLine;

  if (paragraphs.length === 0) {
    return [];
  }

  for (const paragraph of paragraphs) {
    const parts = splitParagraphIntoParts(paragraph, maxBodyLength);

    for (const part of parts) {
      const separator = currentText === "" ? "" : "\n\n";

      if (
        currentText !== "" &&
        currentText.length + separator.length + part.text.length >
          targetBodyLength
      ) {
        chunks.push({
          path: note.path,
          title: note.title,
          headingPath: section.headingPath,
          text: currentText,
          start_line: currentStartLine,
          end_line: currentEndLine,
        });
        currentText = makeOverlap(currentText);
        if (
          currentText.length + separator.length + part.text.length >
          maxBodyLength
        ) {
          currentText = "";
          currentStartLine = part.startLine;
        }
      }

      if (currentText === "") {
        currentStartLine = part.startLine;
        currentText = part.text;
      } else {
        currentText = `${currentText}${separator}${part.text}`;
      }
      currentEndLine = part.endLine;
    }
  }

  if (currentText !== "") {
    chunks.push({
      path: note.path,
      title: note.title,
      headingPath: section.headingPath,
      text: currentText,
      start_line: currentStartLine,
      end_line: currentEndLine,
    });
  }

  return chunks;
}

function splitParagraphs(section: HeadingSection): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let lines: string[] = [];
  let startLine = section.startLine;

  for (const [index, line] of section.lines.entries()) {
    const lineNumber = section.startLine + index;

    if (line.trim() === "") {
      if (hasMeaningfulText(lines)) {
        paragraphs.push({
          text: lines.join("\n"),
          startLine,
          endLine: lineNumber - 1,
        });
      }
      lines = [];
      startLine = lineNumber + 1;
      continue;
    }

    if (lines.length === 0) {
      startLine = lineNumber;
    }
    lines.push(line);
  }

  if (hasMeaningfulText(lines)) {
    paragraphs.push({
      text: lines.join("\n"),
      startLine,
      endLine: section.endLine,
    });
  }

  return paragraphs;
}

function splitParagraphIntoParts(
  paragraph: Paragraph,
  maxLength: number,
): Paragraph[] {
  if (paragraph.text.length <= maxLength) {
    return [paragraph];
  }

  const lines = paragraph.text.split("\n");
  if (lines.length === 1) {
    return splitLongText(paragraph.text, maxLength).map((text) => ({
      text,
      startLine: paragraph.startLine,
      endLine: paragraph.endLine,
    }));
  }

  const parts: Paragraph[] = [];
  let currentLines: string[] = [];
  let currentStartLine = paragraph.startLine;

  for (const [index, line] of lines.entries()) {
    const lineNumber = paragraph.startLine + index;
    const nextText =
      currentLines.length === 0 ? line : `${currentLines.join("\n")}\n${line}`;

    if (line.length > maxLength) {
      pushParagraphPart(parts, currentLines, currentStartLine, lineNumber - 1);
      currentLines = [];
      for (const text of splitLongText(line, maxLength)) {
        parts.push({ text, startLine: lineNumber, endLine: lineNumber });
      }
      currentStartLine = lineNumber + 1;
      continue;
    }

    if (currentLines.length > 0 && nextText.length > maxLength) {
      pushParagraphPart(parts, currentLines, currentStartLine, lineNumber - 1);
      currentLines = [line];
      currentStartLine = lineNumber;
      continue;
    }

    if (currentLines.length === 0) {
      currentStartLine = lineNumber;
    }
    currentLines.push(line);
  }

  pushParagraphPart(parts, currentLines, currentStartLine, paragraph.endLine);
  return parts;
}

function pushParagraphPart(
  parts: Paragraph[],
  lines: string[],
  startLine: number,
  endLine: number,
): void {
  if (hasMeaningfulText(lines)) {
    parts.push({ text: lines.join("\n"), startLine, endLine });
  }
}

function splitLongText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + maxLength, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) {
      break;
    }
    start = Math.max(end - overlapLength, start + 1);
  }

  return chunks.filter((chunk) => chunk !== "");
}

function makeOverlap(text: string): string {
  if (text.length <= overlapLength) {
    return text;
  }

  return text.slice(-overlapLength).trimStart();
}

function hashChunk(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hasMeaningfulText(lines: string[]): boolean {
  return lines.some((line) => line.trim() !== "");
}

function hasMeaningfulSectionText(section: HeadingSection): boolean {
  return section.lines.some(
    (line) => line.trim() !== "" && !isMarkdownHeadingLine(line),
  );
}

function isMarkdownHeadingLine(line: string): boolean {
  return /^ {0,3}#{1,6}\s+.+?\s*$/.test(line);
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

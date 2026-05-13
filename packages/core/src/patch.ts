import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { SearchDatabaseConfig } from "./database.js";
import { VaultgenticError } from "./errors.js";
import { indexVaultFile } from "./indexer.js";
import {
  ensureLeafSymlinkInsideVault,
  ensureParentInsideVault,
  readExistingMarkdownIfPresent,
  resolveSafeMarkdownMutationPath,
} from "./markdown-mutation.js";

export type PatchVaultNoteOptions = {
  path: string;
  patch: string;
  expectedFileHash?: string;
};

export type PatchVaultNoteResult = {
  path: string;
  indexed: boolean;
  warning?: string;
};

export type ParsedPatchLine = {
  kind: "context" | "remove" | "add";
  text: string;
};

export type ParsedPatchChunk = {
  lines: ParsedPatchLine[];
};

export type ParsedVaultPatch = {
  path: string;
  chunks: ParsedPatchChunk[];
};

export class VaultPatchError extends VaultgenticError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultPatchError";
  }
}

const indexingFailedWarning =
  "Note was patched, but indexing failed. Search results may be stale.";
const beginPatchMarker = "*** Begin Patch";
const endPatchMarker = "*** End Patch";
const updateFilePrefix = "*** Update File: ";
const unsupportedAgentPatchOperations = [
  "*** Add File: ",
  "*** Delete File: ",
  "*** Move to: ",
];

export async function patchVaultNote(
  config: SearchDatabaseConfig,
  options: PatchVaultNoteOptions,
): Promise<PatchVaultNoteResult> {
  try {
    const { absolutePath, relativePath } = resolveSafeMarkdownMutationPath(
      config.vaultPath,
      options.path,
      VaultPatchError,
    );

    await ensureParentInsideVault(
      config.vaultPath,
      absolutePath,
      VaultPatchError,
    );
    await ensureLeafSymlinkInsideVault(
      config.vaultPath,
      absolutePath,
      VaultPatchError,
    );
    const existingMarkdown = await readExistingMarkdownIfPresent(
      absolutePath,
      VaultPatchError,
    );
    if (existingMarkdown === undefined) {
      throw new VaultPatchError("Patch path must be an existing markdown file");
    }

    verifyExpectedFileHash(existingMarkdown, options.expectedFileHash);
    const patch = parseAgentPatchText(options.patch, relativePath);
    const patchedMarkdown = applyAgentPatch(existingMarkdown, patch);

    if (patchedMarkdown === existingMarkdown) {
      throw new VaultPatchError("Patch must change the markdown note");
    }

    await ensureParentInsideVault(
      config.vaultPath,
      absolutePath,
      VaultPatchError,
    );
    await ensureLeafSymlinkInsideVault(
      config.vaultPath,
      absolutePath,
      VaultPatchError,
    );
    await writeFile(absolutePath, patchedMarkdown, "utf8");
    const indexResult = await indexPatchedNote(config, relativePath);

    return {
      path: relativePath,
      indexed: indexResult.indexed,
      ...(indexResult.warning === undefined
        ? {}
        : { warning: indexResult.warning }),
    };
  } catch (error) {
    if (error instanceof VaultPatchError) {
      throw error;
    }

    throw new VaultPatchError(
      `Failed to patch vault note ${options.path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function parseAgentPatchText(
  patchText: string,
  relativePath: string,
): ParsedVaultPatch {
  const normalizedPatchText = unwrapPatchText(patchText);
  if (normalizedPatchText.trim() === "") {
    throw new VaultPatchError("Patch must be a non-empty string");
  }

  const lines = normalizedPatchText.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(0) !== beginPatchMarker) {
    throw new VaultPatchError("Patch must start with *** Begin Patch");
  }

  if (lines.at(-1) === "") {
    lines.pop();
  }

  if (lines.at(-1) !== endPatchMarker) {
    throw new VaultPatchError("Patch must end with *** End Patch");
  }

  const operationLines = lines.filter((line) => line.startsWith("*** "));
  const updateLines = operationLines.filter((line) =>
    line.startsWith(updateFilePrefix),
  );

  if (updateLines.length !== 1) {
    throw new VaultPatchError(
      "Patch must contain exactly one Update File operation",
    );
  }

  for (const line of operationLines) {
    if (line === beginPatchMarker || line === endPatchMarker) {
      continue;
    }

    if (line.startsWith(updateFilePrefix)) {
      continue;
    }

    if (
      unsupportedAgentPatchOperations.some((prefix) => line.startsWith(prefix))
    ) {
      throw new VaultPatchError("Patch must update one existing markdown file");
    }

    throw new VaultPatchError(`Unsupported patch operation: ${line}`);
  }

  const patchPath = updateLines[0].slice(updateFilePrefix.length);
  if (patchPath !== relativePath) {
    throw new VaultPatchError("Patch headers must match the requested path");
  }

  const updateIndex = lines.indexOf(updateLines[0]);
  const endIndex = lines.lastIndexOf(endPatchMarker);
  const chunks = parseAgentPatchChunks(lines.slice(updateIndex + 1, endIndex));
  if (chunks.length === 0) {
    throw new VaultPatchError("Patch must contain at least one chunk");
  }

  return { path: patchPath, chunks };
}

function parseAgentPatchChunks(lines: string[]): ParsedPatchChunk[] {
  const chunks: ParsedPatchChunk[] = [];
  let currentChunk: ParsedPatchChunk | undefined;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.startsWith("@@")) {
      if (currentChunk !== undefined) {
        validateChunk(currentChunk);
        chunks.push(currentChunk);
      }

      currentChunk = { lines: [] };
      continue;
    }

    if (currentChunk === undefined) {
      throw new VaultPatchError(
        `Malformed patch at line ${lineNumber}: expected @@ chunk marker`,
      );
    }

    const marker = line.at(0);
    if (marker !== " " && marker !== "-" && marker !== "+") {
      throw new VaultPatchError(
        `Malformed patch at line ${lineNumber}: chunk lines must start with space, -, or +`,
      );
    }

    currentChunk.lines.push({
      kind: marker === " " ? "context" : marker === "-" ? "remove" : "add",
      text: line.slice(1),
    });
  }

  if (currentChunk !== undefined) {
    validateChunk(currentChunk);
    chunks.push(currentChunk);
  }

  return chunks;
}

function validateChunk(chunk: ParsedPatchChunk): void {
  if (chunk.lines.length === 0) {
    throw new VaultPatchError("Patch chunks must contain at least one line");
  }

  if (
    !chunk.lines.some((line) => line.kind === "remove" || line.kind === "add")
  ) {
    throw new VaultPatchError(
      "Patch chunks must add or remove at least one line",
    );
  }
}

function applyAgentPatch(markdown: string, patch: ParsedVaultPatch): string {
  const { lines, lineEnding, hasFinalNewline } = splitMarkdown(markdown);
  const replacements = patch.chunks.map((chunk) =>
    findChunkReplacement(lines, chunk),
  );
  ensureReplacementsDoNotOverlap(replacements);

  const patchedLines = [...lines];
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start,
  )) {
    patchedLines.splice(
      replacement.start,
      replacement.deleteCount,
      ...replacement.addedLines,
    );
  }

  return joinMarkdown(patchedLines, lineEnding, hasFinalNewline);
}

function splitMarkdown(markdown: string): {
  lines: string[];
  lineEnding: "\n" | "\r\n";
  hasFinalNewline: boolean;
} {
  const lineEnding = markdown.includes("\r\n") ? "\r\n" : "\n";
  const hasFinalNewline = markdown.endsWith("\n");
  if (markdown === "") {
    return { lines: [], lineEnding, hasFinalNewline };
  }

  const normalized = markdown.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");

  if (hasFinalNewline) {
    lines.pop();
  }

  return { lines, lineEnding, hasFinalNewline };
}

function joinMarkdown(
  lines: string[],
  lineEnding: "\n" | "\r\n",
  hasFinalNewline: boolean,
): string {
  if (lines.length === 0) {
    return "";
  }

  const content = lines.join(lineEnding);
  return hasFinalNewline ? `${content}${lineEnding}` : content;
}

function findChunkReplacement(
  markdownLines: string[],
  chunk: ParsedPatchChunk,
): { start: number; deleteCount: number; addedLines: string[] } {
  const oldLines = chunk.lines
    .filter((line) => line.kind === "context" || line.kind === "remove")
    .map((line) => line.text);

  const start = findOldLines(markdownLines, oldLines);
  const addedLines = buildAddedLines(markdownLines, start, chunk);
  return { start, deleteCount: oldLines.length, addedLines };
}

function buildAddedLines(
  markdownLines: string[],
  start: number,
  chunk: ParsedPatchChunk,
): string[] {
  const addedLines: string[] = [];
  let oldLineOffset = 0;

  for (const line of chunk.lines) {
    if (line.kind === "context") {
      addedLines.push(markdownLines[start + oldLineOffset]);
      oldLineOffset += 1;
      continue;
    }

    if (line.kind === "remove") {
      oldLineOffset += 1;
      continue;
    }

    addedLines.push(line.text);
  }

  return addedLines;
}

function findOldLines(markdownLines: string[], oldLines: string[]): number {
  if (oldLines.length === 0) {
    if (markdownLines.length === 0) {
      return 0;
    }

    throw new VaultPatchError(
      "Patch insertion-only chunks must include context for non-empty notes",
    );
  }

  const exactMatches = findMatchingLineRanges(
    markdownLines,
    oldLines,
    (line) => line,
  );

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  if (exactMatches.length > 1) {
    throw new VaultPatchError(
      "Patch old lines matched multiple locations; add context to disambiguate",
    );
  }

  const tolerantMatches = findMatchingLineRanges(
    markdownLines,
    oldLines,
    normalizePatchLineForMatch,
  );

  if (tolerantMatches.length === 0) {
    throw new VaultPatchError(
      `Patch old lines were not found: ${JSON.stringify(oldLines.join("\n"))}`,
    );
  }

  if (tolerantMatches.length > 1) {
    throw new VaultPatchError(
      "Patch old lines matched multiple locations; add context to disambiguate",
    );
  }

  return tolerantMatches[0];
}

function findMatchingLineRanges(
  markdownLines: string[],
  oldLines: string[],
  normalize: (line: string) => string,
): number[] {
  const normalizedOldLines = oldLines.map(normalize);
  const matches: number[] = [];

  for (
    let index = 0;
    index <= markdownLines.length - oldLines.length;
    index += 1
  ) {
    if (
      normalizedOldLines.every(
        (line, offset) => normalize(markdownLines[index + offset]) === line,
      )
    ) {
      matches.push(index);
    }
  }

  return matches;
}

function normalizePatchLineForMatch(line: string): string {
  return line
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/gu, "-")
    .trim();
}

function ensureReplacementsDoNotOverlap(
  replacements: Array<{ start: number; deleteCount: number }>,
): void {
  const sorted = [...replacements].sort(
    (left, right) => left.start - right.start,
  );

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous.start === current.start && previous.deleteCount === 0) {
      throw new VaultPatchError(
        "Patch insertion-only chunks must target distinct locations",
      );
    }

    if (previous.start + previous.deleteCount > current.start) {
      throw new VaultPatchError(
        "Patch chunks must not modify overlapping old lines",
      );
    }
  }
}

function unwrapPatchText(patchText: string): string {
  const trimmed = patchText.trim();
  const lines = trimmed.split(/\r?\n/u);

  if (lines[0]?.startsWith("```") && lines.at(-1) === "```") {
    return lines.slice(1, -1).join("\n");
  }

  const heredocMatch = lines[0]?.match(/^cat\s+<<["']?([A-Za-z0-9_]+)["']?$/u);
  if (heredocMatch !== null && lines.at(-1) === heredocMatch[1]) {
    return lines.slice(1, -1).join("\n");
  }

  return trimmed;
}

function verifyExpectedFileHash(
  markdown: string,
  expectedFileHash: string | undefined,
): void {
  if (expectedFileHash === undefined) {
    return;
  }

  const hashPrefix = "sha256:";
  if (
    !expectedFileHash.startsWith(hashPrefix) ||
    !/^[a-f0-9]{64}$/iu.test(expectedFileHash.slice(hashPrefix.length))
  ) {
    throw new VaultPatchError("Expected file hash must use sha256:<hex>");
  }

  const actualHash = `${hashPrefix}${createHash("sha256")
    .update(markdown, "utf8")
    .digest("hex")}`;
  if (actualHash !== expectedFileHash.toLowerCase()) {
    throw new VaultPatchError("Expected file hash does not match current note");
  }
}

async function indexPatchedNote(
  config: SearchDatabaseConfig,
  relativePath: string,
): Promise<{ indexed: boolean; warning?: string }> {
  try {
    await indexVaultFile(config, relativePath);
    return { indexed: true };
  } catch {
    return {
      indexed: false,
      warning: indexingFailedWarning,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

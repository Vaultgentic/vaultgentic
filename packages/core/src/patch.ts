import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { applyPatch, parsePatch, type StructuredPatch } from "diff";
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
const hunkHeaderPattern = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/u;
const combinedDiffHunkHeaderPattern = /^@@@ /u;
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
    const patch = parseSinglePatch(options.patch, relativePath);
    const patchedMarkdown = applyPatch(existingMarkdown, patch, {
      fuzzFactor: 0,
      autoConvertLineEndings: false,
    });

    if (patchedMarkdown === false) {
      throw new VaultPatchError("Patch hunks did not apply cleanly");
    }

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

function parseSinglePatch(
  patchText: string,
  relativePath: string,
): StructuredPatch {
  // Append \n so that a blank context line at the end of the last hunk is
  // never the final element of split("\n"), which the diff library rejects.
  const normalizedPatchText = `${patchText}\n`;
  validateRawPatchText(normalizedPatchText);

  let patches: StructuredPatch[];
  try {
    patches = parsePatch(normalizedPatchText);
  } catch (error) {
    throw new VaultPatchError(`Malformed patch: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (patches.length !== 1) {
    throw new VaultPatchError("Patch must target exactly one markdown file");
  }

  const patch = patches[0];
  if (patch.hunks.length === 0) {
    throw new VaultPatchError("Patch must contain at least one hunk");
  }

  if (patch.isCreate === true || patch.isDelete === true) {
    throw new VaultPatchError("Patch must update an existing markdown file");
  }

  if (hasBooleanPatchFlag(patch, "isRename")) {
    throw new VaultPatchError("Patch must not rename markdown files");
  }

  if (hasBooleanPatchFlag(patch, "isCopy")) {
    throw new VaultPatchError("Patch must not copy markdown files");
  }

  if (hasBooleanPatchFlag(patch, "isBinary")) {
    throw new VaultPatchError("Patch must be a text unified diff");
  }

  const oldPath = normalizePatchPath(patch.oldFileName, "old");
  const newPath = normalizePatchPath(patch.newFileName, "new");
  if (oldPath !== newPath) {
    throw new VaultPatchError("Patch old and new file headers must match");
  }

  if (oldPath !== relativePath) {
    throw new VaultPatchError("Patch headers must match the requested path");
  }

  return patch;
}

function validateRawPatchText(patchText: string): void {
  if (typeof patchText !== "string" || patchText.trim() === "") {
    throw new VaultPatchError("Patch must be a non-empty string");
  }

  let inHunk = false;
  const lines = patchText.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineNumber = index + 1;

    if (line === "") {
      continue;
    }

    if (combinedDiffHunkHeaderPattern.test(line)) {
      throw new VaultPatchError(
        `Unsupported patch at line ${lineNumber}: ${JSON.stringify(line)}. Combined merge diffs are not supported.`,
      );
    }

    if (hunkHeaderPattern.test(line)) {
      inHunk = true;
      continue;
    }

    if (line.startsWith("@@")) {
      throw new VaultPatchError(
        `Malformed patch at line ${lineNumber}: ${JSON.stringify(line)}. Expected unified diff hunk header like "@@ -1,2 +1,2 @@".`,
      );
    }

    if (inHunk && /^[ +\\-]/u.test(line)) {
      continue;
    }

    if (inHunk && line.startsWith("\\ No newline at end of file")) {
      continue;
    }

    const unsupportedReason = unsupportedPatchMetadataReason(line);
    if (unsupportedReason !== undefined) {
      throw new VaultPatchError(
        `Unsupported patch at line ${lineNumber}: ${JSON.stringify(line)}. ${unsupportedReason}`,
      );
    }

    if (isPatchMetadataLine(line)) {
      inHunk = false;
      continue;
    }

    throw new VaultPatchError(
      `Malformed patch at line ${lineNumber}: ${JSON.stringify(line)}. Expected a unified diff header, hunk header, hunk line starting with " ", "+", or "-", or "\\ No newline at end of file".`,
    );
  }
}

function unsupportedPatchMetadataReason(line: string): string | undefined {
  if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
    return "Combined merge diffs are not supported.";
  }

  if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
    return "Rename patches are not supported.";
  }

  if (line.startsWith("copy from ") || line.startsWith("copy to ")) {
    return "Copy patches are not supported.";
  }

  if (line.startsWith("Binary files ") || line === "GIT binary patch") {
    return "Binary patches are not supported.";
  }

  return undefined;
}

function isPatchMetadataLine(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    /^old mode \d+$/u.test(line) ||
    /^new mode \d+$/u.test(line) ||
    /^new file mode \d+$/u.test(line) ||
    /^deleted file mode \d+$/u.test(line) ||
    /^similarity index \d+%$/u.test(line) ||
    /^dissimilarity index \d+%$/u.test(line)
  );
}

function hasBooleanPatchFlag(
  patch: StructuredPatch,
  flag: "isRename" | "isCopy" | "isBinary",
): boolean {
  return (
    (patch as StructuredPatch & Record<typeof flag, unknown>)[flag] === true
  );
}

function normalizePatchPath(
  patchPath: string | undefined,
  label: "old" | "new",
): string {
  if (patchPath === undefined) {
    throw new VaultPatchError(`Patch ${label} file header is required`);
  }

  if (patchPath === "/dev/null") {
    throw new VaultPatchError("Patch must not create or delete files");
  }

  if (patchPath.startsWith("a/") || patchPath.startsWith("b/")) {
    return patchPath.slice(2);
  }

  return patchPath;
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

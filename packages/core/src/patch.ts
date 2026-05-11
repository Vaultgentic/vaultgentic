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

export class VaultPatchError extends VaultgenticError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultPatchError";
  }
}

const indexingFailedWarning =
  "Note was patched, but indexing failed. Search results may be stale.";

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

function parseSinglePatch(
  patchText: string,
  relativePath: string,
): StructuredPatch {
  validateRawPatchText(patchText);

  let patches: StructuredPatch[];
  try {
    patches = parsePatch(patchText);
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
  for (const line of patchText.split("\n")) {
    if (line === "") {
      continue;
    }

    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }

    if (inHunk && /^[ +\\-]/u.test(line)) {
      continue;
    }

    if (isPatchMetadataLine(line)) {
      inHunk = false;
      continue;
    }

    throw new VaultPatchError(
      "Patch contains unsupported trailing or metadata text",
    );
  }
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
    /^dissimilarity index \d+%$/u.test(line) ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ") ||
    line.startsWith("Binary files ")
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

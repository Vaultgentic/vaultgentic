import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import type { SearchDatabaseConfig } from "./database.js";
import { VaultgenticError } from "./errors.js";
import {
  moveFilesystemFile,
  pruneEmptyParentDirectories,
} from "./filesystem-move.js";
import { indexVaultFile, removeIndexedVaultPath } from "./indexer.js";
import {
  ensureLeafSymlinkInsideVault,
  ensureNearestExistingParentInsideVault,
  ensureParentInsideVault,
  readExistingMarkdownIfPresent,
  resolveSafeMarkdownMutationPath,
} from "./markdown-mutation.js";

export type MoveVaultNoteOptions = {
  fromPath: string;
  toPath: string;
  expectedFileHash?: string;
  overwrite?: boolean;
  pruneEmptyParents?: boolean;
};

export type MoveVaultNoteResult = {
  fromPath: string;
  toPath: string;
  moved: true;
  overwritten: boolean;
  prunedDirectories: string[];
  warning?: string;
};

export class VaultMoveError extends VaultgenticError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultMoveError";
  }
}

const indexingFailedWarning =
  "Note was moved, but search index update failed. Search results may be stale.";
const directoryPruningFailedWarning =
  "Note was moved, but empty parent directory pruning failed.";

export async function moveVaultNote(
  config: SearchDatabaseConfig,
  options: MoveVaultNoteOptions,
): Promise<MoveVaultNoteResult> {
  try {
    const from = resolveSafeMarkdownMutationPath(
      config.vaultPath,
      options.fromPath,
      VaultMoveError,
    );
    const to = resolveSafeMarkdownMutationPath(
      config.vaultPath,
      options.toPath,
      VaultMoveError,
    );

    if (from.relativePath === to.relativePath) {
      throw new VaultMoveError("Move destination must differ from source path");
    }

    await ensureParentInsideVault(
      config.vaultPath,
      from.absolutePath,
      VaultMoveError,
    );
    await ensureLeafSymlinkInsideVault(
      config.vaultPath,
      from.absolutePath,
      VaultMoveError,
    );
    const existingMarkdown = await readExistingMarkdownIfPresent(
      from.absolutePath,
      VaultMoveError,
    );
    if (existingMarkdown === undefined) {
      throw new VaultMoveError("Move source must be an existing markdown file");
    }
    if ((await lstat(from.absolutePath)).isSymbolicLink()) {
      throw new VaultMoveError("Move source must be a regular markdown file");
    }

    verifyExpectedFileHash(existingMarkdown, options.expectedFileHash);

    await ensureLeafSymlinkInsideVault(
      config.vaultPath,
      to.absolutePath,
      VaultMoveError,
    );
    const destinationMarkdown = await readExistingMarkdownIfPresent(
      to.absolutePath,
      VaultMoveError,
    );
    const overwritten = destinationMarkdown !== undefined;
    if (overwritten && options.overwrite !== true) {
      throw new VaultMoveError(
        "Move destination already exists; pass overwrite=true to replace it",
      );
    }

    await ensureNearestExistingParentInsideVault(
      config.vaultPath,
      to.absolutePath,
      VaultMoveError,
    );
    await mkdir(path.dirname(to.absolutePath), { recursive: true });
    await ensureParentInsideVault(
      config.vaultPath,
      to.absolutePath,
      VaultMoveError,
    );
    await moveFilesystemFile({
      fromAbsolutePath: from.absolutePath,
      toAbsolutePath: to.absolutePath,
      overwrite: options.overwrite === true,
    });
    await ensureLeafSymlinkInsideVault(
      config.vaultPath,
      to.absolutePath,
      VaultMoveError,
    );

    const pruneResult = await pruneMovedSourceParents(
      config,
      from.relativePath,
      {
        enabled: options.pruneEmptyParents !== false,
      },
    );
    const warning = combineWarnings(
      pruneResult.warning,
      await updateMovedNoteIndex(config, from.relativePath, to.relativePath),
    );

    return {
      fromPath: from.relativePath,
      toPath: to.relativePath,
      moved: true,
      overwritten,
      prunedDirectories: pruneResult.prunedDirectories,
      ...(warning === undefined ? {} : { warning }),
    };
  } catch (error) {
    if (error instanceof VaultMoveError) {
      throw error;
    }

    throw new VaultMoveError(
      `Failed to move vault note ${options.fromPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function pruneMovedSourceParents(
  config: SearchDatabaseConfig,
  relativePath: string,
  options: { enabled: boolean },
): Promise<{ prunedDirectories: string[]; warning?: string }> {
  try {
    return await pruneEmptyParentDirectories({
      vaultPath: config.vaultPath,
      relativePath,
      enabled: options.enabled,
      failureWarning: directoryPruningFailedWarning,
    });
  } catch (error) {
    throw new VaultMoveError(directoryPruningFailedWarning, { cause: error });
  }
}

async function updateMovedNoteIndex(
  config: SearchDatabaseConfig,
  fromPath: string,
  toPath: string,
): Promise<string | undefined> {
  try {
    removeIndexedVaultPath(config, fromPath);
    await indexVaultFile(config, toPath);
    return undefined;
  } catch {
    return indexingFailedWarning;
  }
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
    throw new VaultMoveError("Expected file hash must use sha256:<hex>");
  }

  const actualHash = `${hashPrefix}${createHash("sha256")
    .update(markdown, "utf8")
    .digest("hex")}`;
  if (actualHash !== expectedFileHash.toLowerCase()) {
    throw new VaultMoveError("Expected file hash does not match current note");
  }
}

function combineWarnings(
  firstWarning: string | undefined,
  secondWarning: string | undefined,
): string | undefined {
  if (firstWarning === undefined) {
    return secondWarning;
  }
  if (secondWarning === undefined) {
    return firstWarning;
  }

  return `${firstWarning} ${secondWarning}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

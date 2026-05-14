import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import {
  defaultArchiveFolder,
  defaultArchiveOnRemove,
  resolveVaultRelativePath,
} from "./config.js";
import type { SearchDatabaseConfig } from "./database.js";
import { VaultgenticError } from "./errors.js";
import { removeIndexedVaultPath } from "./indexer.js";
import {
  ensureLeafSymlinkInsideVault,
  ensureNearestExistingParentInsideVault,
  ensureParentInsideVault,
  readExistingMarkdownIfPresent,
  resolveSafeMarkdownMutationPath,
} from "./markdown-mutation.js";

export type RemoveVaultNoteOptions = {
  path: string;
  expectedFileHash?: string;
  pruneEmptyParents?: boolean;
};

export type RemoveVaultNoteResult = {
  path: string;
  operation: "archived" | "deleted";
  indexRemoved: boolean;
  prunedDirectories: string[];
  archivedPath?: string;
  warning?: string;
};

type RemoveVaultNoteConfig = SearchDatabaseConfig & {
  archiveOnRemove?: boolean;
  archiveFolder?: string;
};

type FilesystemRemoveResult = {
  operation: "archived" | "deleted";
  archivedPath?: string;
};

export class VaultRemoveError extends VaultgenticError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultRemoveError";
  }
}

const indexCleanupFailedWarning =
  "Note was removed, but search index cleanup failed. Search results may be stale.";

const directoryPruningFailedWarning =
  "Note was removed, but empty parent directory pruning failed.";

export async function removeVaultNote(
  config: RemoveVaultNoteConfig,
  options: RemoveVaultNoteOptions,
): Promise<RemoveVaultNoteResult> {
  try {
    const { absolutePath, relativePath } = resolveSafeMarkdownMutationPath(
      config.vaultPath,
      options.path,
      VaultRemoveError,
    );

    await ensureParentInsideVault(
      config.vaultPath,
      absolutePath,
      VaultRemoveError,
    );
    await ensureLeafSymlinkInsideVault(
      config.vaultPath,
      absolutePath,
      VaultRemoveError,
    );
    const existingMarkdown = await readExistingMarkdownIfPresent(
      absolutePath,
      VaultRemoveError,
    );
    if (existingMarkdown === undefined) {
      throw new VaultRemoveError(
        "Remove path must be an existing markdown file",
      );
    }

    verifyExpectedFileHash(existingMarkdown, options.expectedFileHash);

    const archiveOnRemove = config.archiveOnRemove ?? defaultArchiveOnRemove;
    const removeResult: FilesystemRemoveResult = archiveOnRemove
      ? await archiveNote(config, absolutePath, relativePath)
      : await deleteNote(absolutePath);
    const pruneResult = await pruneEmptyParentDirectories(
      config,
      relativePath,
      {
        enabled: options.pruneEmptyParents !== false,
      },
    );
    const indexResult = removeIndexedNote(config, relativePath);
    const warning = combineWarnings(pruneResult.warning, indexResult.warning);

    return {
      path: relativePath,
      operation: removeResult.operation,
      indexRemoved: indexResult.indexRemoved,
      prunedDirectories: pruneResult.prunedDirectories,
      ...(removeResult.archivedPath === undefined
        ? {}
        : { archivedPath: removeResult.archivedPath }),
      ...(warning === undefined ? {} : { warning }),
    };
  } catch (error) {
    if (error instanceof VaultRemoveError) {
      throw error;
    }

    throw new VaultRemoveError(
      `Failed to remove vault note ${options.path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function pruneEmptyParentDirectories(
  config: RemoveVaultNoteConfig,
  relativePath: string,
  options: { enabled: boolean },
): Promise<{ prunedDirectories: string[]; warning?: string }> {
  if (!options.enabled) {
    return { prunedDirectories: [] };
  }

  const prunedDirectories: string[] = [];
  let parentRelativePath = path.posix.dirname(relativePath);

  try {
    while (shouldPruneParent(parentRelativePath)) {
      const absoluteParentPath = path.resolve(
        config.vaultPath,
        parentRelativePath,
      );
      ensurePathInsideVault(config.vaultPath, absoluteParentPath);

      try {
        await rmdir(absoluteParentPath);
      } catch (error) {
        if (isDirectoryNotEmptyError(error) || isMissingDirectoryError(error)) {
          break;
        }

        throw error;
      }

      prunedDirectories.push(parentRelativePath);
      parentRelativePath = path.posix.dirname(parentRelativePath);
    }

    return { prunedDirectories };
  } catch {
    return {
      prunedDirectories,
      warning: directoryPruningFailedWarning,
    };
  }
}

function shouldPruneParent(relativePath: string): boolean {
  if (relativePath === "." || relativePath === "") {
    return false;
  }

  return relativePath.split("/").length > 1;
}

function ensurePathInsideVault(vaultPath: string, absolutePath: string): void {
  const relativePath = path.relative(vaultPath, absolutePath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new VaultRemoveError("Pruned directory must stay inside the vault");
  }
}

async function archiveNote(
  config: RemoveVaultNoteConfig,
  absolutePath: string,
  relativePath: string,
): Promise<{ operation: "archived"; archivedPath: string }> {
  const archivePath = resolveArchivePath(config, relativePath);
  const archiveAbsolutePath = path.join(config.vaultPath, archivePath);

  await ensureNearestExistingParentInsideVault(
    config.vaultPath,
    archiveAbsolutePath,
    VaultRemoveError,
  );
  await mkdir(path.dirname(archiveAbsolutePath), { recursive: true });
  await ensureParentInsideVault(
    config.vaultPath,
    archiveAbsolutePath,
    VaultRemoveError,
  );
  const targetPath = await copyToAvailableArchivePath(
    absolutePath,
    archiveAbsolutePath,
    archivePath,
  );
  await rm(absolutePath);

  return { operation: "archived", archivedPath: targetPath.relativePath };
}

async function deleteNote(
  absolutePath: string,
): Promise<FilesystemRemoveResult> {
  await rm(absolutePath);

  return { operation: "deleted" };
}

function removeIndexedNote(
  config: SearchDatabaseConfig,
  relativePath: string,
): { indexRemoved: boolean; warning?: string } {
  try {
    removeIndexedVaultPath(config, relativePath);
    return { indexRemoved: true };
  } catch {
    return {
      indexRemoved: false,
      warning: indexCleanupFailedWarning,
    };
  }
}

function resolveArchivePath(
  config: RemoveVaultNoteConfig,
  relativePath: string,
): string {
  const archiveFolder = config.archiveFolder ?? defaultArchiveFolder;

  try {
    const resolvedArchiveFolder = resolveVaultRelativePath(
      config.vaultPath,
      archiveFolder,
    );

    return `${resolvedArchiveFolder}/${relativePath}`;
  } catch (error) {
    throw new VaultRemoveError("Archive folder must be vault-relative", {
      cause: error,
    });
  }
}

async function copyToAvailableArchivePath(
  sourcePath: string,
  archiveAbsolutePath: string,
  archiveRelativePath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  const parsedPath = path.parse(archiveAbsolutePath);
  const parsedRelativePath = path.posix.parse(archiveRelativePath);

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? "" : ` (${attempt})`;
    const absolutePath = path.join(
      parsedPath.dir,
      `${parsedPath.name}${suffix}${parsedPath.ext}`,
    );
    const relativePath = path.posix.join(
      parsedRelativePath.dir,
      `${parsedRelativePath.name}${suffix}${parsedRelativePath.ext}`,
    );
    try {
      await copyFile(sourcePath, absolutePath, constants.COPYFILE_EXCL);
      return { absolutePath, relativePath };
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        continue;
      }

      throw error;
    }
  }

  throw new VaultRemoveError("Could not find a non-colliding archive path");
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
    throw new VaultRemoveError("Expected file hash must use sha256:<hex>");
  }

  const actualHash = `${hashPrefix}${createHash("sha256")
    .update(markdown, "utf8")
    .digest("hex")}`;
  if (actualHash !== expectedFileHash.toLowerCase()) {
    throw new VaultRemoveError(
      "Expected file hash does not match current note",
    );
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isDirectoryNotEmptyError(error: unknown): boolean {
  return (
    isErrorWithCode(error, "ENOTEMPTY") || isErrorWithCode(error, "EEXIST")
  );
}

function isMissingDirectoryError(error: unknown): boolean {
  return isErrorWithCode(error, "ENOENT");
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
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

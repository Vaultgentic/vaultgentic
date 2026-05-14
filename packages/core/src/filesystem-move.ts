import { constants } from "node:fs";
import { copyFile, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";

export type MoveFilesystemFileOptions = {
  fromAbsolutePath: string;
  toAbsolutePath: string;
  overwrite: boolean;
};

export type PruneEmptyParentDirectoriesOptions = {
  enabled: boolean;
  failureWarning: string;
  vaultPath: string;
  relativePath: string;
};

export async function moveFilesystemFile(
  options: MoveFilesystemFileOptions,
): Promise<void> {
  if (!options.overwrite) {
    await copyFile(
      options.fromAbsolutePath,
      options.toAbsolutePath,
      constants.COPYFILE_EXCL,
    );
    await rm(options.fromAbsolutePath);
    return;
  }

  await rename(options.fromAbsolutePath, options.toAbsolutePath);
}

export async function pruneEmptyParentDirectories(
  options: PruneEmptyParentDirectoriesOptions,
): Promise<{ prunedDirectories: string[]; warning?: string }> {
  if (!options.enabled) {
    return { prunedDirectories: [] };
  }

  const prunedDirectories: string[] = [];
  let parentRelativePath = path.posix.dirname(options.relativePath);

  try {
    while (shouldPruneParent(parentRelativePath)) {
      const absoluteParentPath = path.resolve(
        options.vaultPath,
        parentRelativePath,
      );
      ensurePathInsideVault(options.vaultPath, absoluteParentPath);

      try {
        await rmdir(absoluteParentPath);
      } catch (error) {
        if (isDirectoryNotEmptyError(error) || isMissingPathError(error)) {
          break;
        }

        throw error;
      }

      prunedDirectories.push(parentRelativePath);
      parentRelativePath = path.posix.dirname(parentRelativePath);
    }

    return { prunedDirectories };
  } catch {
    return { prunedDirectories, warning: options.failureWarning };
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
    throw new Error("Pruned directory must stay inside the vault");
  }
}

function isDirectoryNotEmptyError(error: unknown): boolean {
  return (
    isErrorWithCode(error, "ENOTEMPTY") || isErrorWithCode(error, "EEXIST")
  );
}

function isMissingPathError(error: unknown): boolean {
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

import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { ConfigServiceError, resolveVaultRelativePath } from "./config.js";

export type MarkdownMutationError = new (
  message: string,
  options?: { cause?: unknown },
) => Error;

export type SafeMarkdownMutationTarget = {
  relativePath: string;
  absolutePath: string;
};

export function resolveSafeMarkdownMutationPath(
  vaultPath: string,
  target: string,
  createError: MarkdownMutationError,
): SafeMarkdownMutationTarget {
  validateRawMarkdownMutationPath(target, createError);

  try {
    const relativePath = resolveVaultRelativePath(vaultPath, target);
    if (!relativePath.endsWith(".md")) {
      throw new createError(`Write path must end with .md: ${target}`);
    }

    return {
      relativePath,
      absolutePath: path.join(vaultPath, relativePath),
    };
  } catch (error) {
    if (error instanceof createError) {
      throw error;
    }

    if (error instanceof ConfigServiceError) {
      throw new createError(`Invalid write path ${target}: ${error.message}`, {
        cause: error,
      });
    }

    throw error;
  }
}

export async function ensureLeafSymlinkInsideVault(
  vaultPath: string,
  absolutePath: string,
  createError: MarkdownMutationError,
): Promise<void> {
  const existing = await lstat(absolutePath).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  });

  if (existing?.isSymbolicLink() === true) {
    await ensurePathInsideVault(vaultPath, absolutePath, createError);
  }
}

export async function readExistingMarkdownIfPresent(
  absolutePath: string,
  createError: MarkdownMutationError,
): Promise<string | undefined> {
  const existing = await lstat(absolutePath).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  });

  if (existing === undefined) {
    return undefined;
  }

  if (!existing.isFile() && !existing.isSymbolicLink()) {
    throw new createError("Write path already exists and is not a file");
  }

  return readExistingMarkdownFile(absolutePath, createError);
}

export async function ensureNearestExistingParentInsideVault(
  vaultPath: string,
  absolutePath: string,
  createError: MarkdownMutationError,
): Promise<void> {
  const resolvedVaultPath = path.resolve(vaultPath);
  let parentPath = path.dirname(absolutePath);

  while (parentPath !== resolvedVaultPath) {
    const parentStat = await lstat(parentPath).catch((error: unknown) => {
      if (isNotFoundError(error)) {
        return undefined;
      }

      throw error;
    });

    if (parentStat === undefined) {
      parentPath = path.dirname(parentPath);
      continue;
    }

    if (!parentStat.isDirectory() && !parentStat.isSymbolicLink()) {
      throw new createError("Write path parent must be a directory");
    }

    if (parentStat.isSymbolicLink()) {
      await ensurePathInsideVault(vaultPath, parentPath, createError);
    }

    return;
  }
}

export async function ensureParentInsideVault(
  vaultPath: string,
  absolutePath: string,
  createError: MarkdownMutationError,
): Promise<void> {
  await ensurePathInsideVault(
    vaultPath,
    path.dirname(absolutePath),
    createError,
  );
}

async function readExistingMarkdownFile(
  absolutePath: string,
  createError: MarkdownMutationError,
): Promise<string> {
  const content = await readFile(absolutePath);

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new createError("Existing markdown file must be readable UTF-8", {
      cause: error,
    });
  }
}

function validateRawMarkdownMutationPath(
  target: string,
  createError: MarkdownMutationError,
): void {
  if (typeof target !== "string" || target.trim() === "") {
    throw new createError("Write path must be a non-empty string");
  }

  if (target.includes("\\")) {
    throw new createError("Write path must use forward slashes");
  }

  if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) {
    throw new createError("Write path must be vault-relative");
  }

  if (hasControlCharacter(target)) {
    throw new createError("Write path must not contain control characters");
  }

  if (/[<>:"|?*]/u.test(target)) {
    throw new createError(
      "Write path must not contain Windows-reserved characters",
    );
  }

  if (!target.endsWith(".md")) {
    throw new createError("Write path must end with lowercase .md");
  }

  for (const segment of target.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new createError("Write path must not contain traversal segments");
    }

    if (segment.startsWith(".")) {
      throw new createError("Write path must not contain hidden segments");
    }
  }
}

function hasControlCharacter(target: string): boolean {
  for (const character of target) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }

  return false;
}

async function ensurePathInsideVault(
  vaultPath: string,
  absolutePath: string,
  createError: MarkdownMutationError,
): Promise<void> {
  const [realVaultPath, realCandidatePath] = await Promise.all([
    realpath(vaultPath),
    realpath(absolutePath),
  ]);
  const relativeParentPath = path.relative(realVaultPath, realCandidatePath);

  if (
    relativeParentPath === ".." ||
    relativeParentPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeParentPath)
  ) {
    throw new createError("Write path parent must stay inside the vault");
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

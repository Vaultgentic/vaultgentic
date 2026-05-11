import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigServiceError, resolveVaultRelativePath } from "./config.js";
import type { SearchDatabaseConfig } from "./database.js";
import { VaultgenticError } from "./errors.js";

export type WriteVaultNoteOptions = {
  path: string;
  frontmatter?: Record<string, unknown>;
  body: string;
};

export type WriteVaultNoteResult = {
  path: string;
  operation: "created" | "updated";
  indexed: boolean;
  warning?: string;
};

export class VaultWriteError extends VaultgenticError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultWriteError";
  }
}

const unindexedWriteWarning =
  "Note was written, but indexing has not run. Search results may be stale.";

export async function writeVaultNote(
  config: SearchDatabaseConfig,
  options: WriteVaultNoteOptions,
): Promise<WriteVaultNoteResult> {
  try {
    const relativePath = resolveWritePath(config.vaultPath, options.path);
    const absolutePath = path.join(config.vaultPath, relativePath);

    await ensureLeafIsNotSymlink(absolutePath);
    const operation = (await noteExists(absolutePath)) ? "updated" : "created";

    await ensureNearestExistingParentInsideVault(
      config.vaultPath,
      absolutePath,
    );
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await ensureParentInsideVault(config.vaultPath, absolutePath);
    await ensureLeafIsNotSymlink(absolutePath);
    await writeFile(absolutePath, formatMarkdown(options), "utf8");

    return {
      path: relativePath,
      operation,
      indexed: false,
      warning: unindexedWriteWarning,
    };
  } catch (error) {
    if (error instanceof VaultWriteError) {
      throw error;
    }

    throw new VaultWriteError(
      `Failed to write vault note ${options.path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function ensureNearestExistingParentInsideVault(
  vaultPath: string,
  absolutePath: string,
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
      throw new VaultWriteError("Write path parent must be a directory");
    }

    if (parentStat.isSymbolicLink()) {
      await ensurePathInsideVault(vaultPath, parentPath);
    }

    return;
  }
}

async function ensureParentInsideVault(
  vaultPath: string,
  absolutePath: string,
): Promise<void> {
  await ensurePathInsideVault(vaultPath, path.dirname(absolutePath));
}

async function ensurePathInsideVault(
  vaultPath: string,
  absolutePath: string,
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
    throw new VaultWriteError("Write path parent must stay inside the vault");
  }
}

async function ensureLeafIsNotSymlink(absolutePath: string): Promise<void> {
  const existing = await lstat(absolutePath).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  });

  if (existing?.isSymbolicLink() === true) {
    throw new VaultWriteError("Write path must not be a symlink");
  }
}

function resolveWritePath(vaultPath: string, target: string): string {
  try {
    const relativePath = resolveVaultRelativePath(vaultPath, target);
    if (!relativePath.endsWith(".md")) {
      throw new VaultWriteError(`Write path must end with .md: ${target}`);
    }

    return relativePath;
  } catch (error) {
    if (error instanceof VaultWriteError) {
      throw error;
    }

    if (error instanceof ConfigServiceError) {
      throw new VaultWriteError(
        `Invalid write path ${target}: ${error.message}`,
        {
          cause: error,
        },
      );
    }

    throw error;
  }
}

async function noteExists(absolutePath: string): Promise<boolean> {
  const existing = await lstat(absolutePath).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  });

  if (existing === undefined) {
    return false;
  }

  if (existing.isSymbolicLink()) {
    throw new VaultWriteError("Write path must not be a symlink");
  }

  if (!existing.isFile()) {
    throw new VaultWriteError("Write path already exists and is not a file");
  }

  await readFile(absolutePath, "utf8");
  return true;
}

function formatMarkdown(options: WriteVaultNoteOptions): string {
  if (options.frontmatter === undefined) {
    return options.body;
  }

  const entries = Object.entries(options.frontmatter);
  if (entries.length === 0) {
    return `---\n---\n\n${options.body}`;
  }

  const frontmatter = entries
    .map(([key, value]) => `${key}: ${formatFrontmatterValue(value)}`)
    .join("\n");

  return `---\n${frontmatter}\n---\n\n${options.body}`;
}

function formatFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(formatFrontmatterScalar).join(", ")}]`;
  }

  return formatFrontmatterScalar(value);
}

function formatFrontmatterScalar(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }

  return JSON.stringify(value);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

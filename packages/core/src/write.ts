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
    validateRawWritePath(options.path);
    const relativePath = resolveWritePath(config.vaultPath, options.path);
    const absolutePath = path.join(config.vaultPath, relativePath);

    await ensureLeafSymlinkInsideVault(config.vaultPath, absolutePath);
    const operation = (await noteExists(absolutePath)) ? "updated" : "created";

    await ensureNearestExistingParentInsideVault(
      config.vaultPath,
      absolutePath,
    );
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await ensureParentInsideVault(config.vaultPath, absolutePath);
    await ensureLeafSymlinkInsideVault(config.vaultPath, absolutePath);
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

function validateRawWritePath(target: string): void {
  if (typeof target !== "string" || target.trim() === "") {
    throw new VaultWriteError("Write path must be a non-empty string");
  }

  if (target.includes("\\")) {
    throw new VaultWriteError("Write path must use forward slashes");
  }

  if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) {
    throw new VaultWriteError("Write path must be vault-relative");
  }

  if (hasControlCharacter(target)) {
    throw new VaultWriteError("Write path must not contain control characters");
  }

  if (/[<>:"|?*]/u.test(target)) {
    throw new VaultWriteError(
      "Write path must not contain Windows-reserved characters",
    );
  }

  if (!target.endsWith(".md")) {
    throw new VaultWriteError("Write path must end with lowercase .md");
  }

  for (const segment of target.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new VaultWriteError(
        "Write path must not contain traversal segments",
      );
    }

    if (segment.startsWith(".")) {
      throw new VaultWriteError("Write path must not contain hidden segments");
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

async function ensureLeafSymlinkInsideVault(
  vaultPath: string,
  absolutePath: string,
): Promise<void> {
  const existing = await lstat(absolutePath).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  });

  if (existing?.isSymbolicLink() === true) {
    await ensurePathInsideVault(vaultPath, absolutePath);
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

  if (!existing.isFile() && !existing.isSymbolicLink()) {
    throw new VaultWriteError("Write path already exists and is not a file");
  }

  await readExistingMarkdownFile(absolutePath);
  return true;
}

async function readExistingMarkdownFile(absolutePath: string): Promise<void> {
  const content = await readFile(absolutePath);

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new VaultWriteError("Existing markdown file must be readable UTF-8", {
      cause: error,
    });
  }
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

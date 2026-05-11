import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { ConfigServiceError, resolveVaultRelativePath } from "./config.js";
import type { SearchDatabaseConfig } from "./database.js";
import { VaultgenticError } from "./errors.js";
import { indexVaultFile } from "./indexer.js";

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

const indexingFailedWarning =
  "Note was written, but indexing failed. Search results may be stale.";

export async function writeVaultNote(
  config: SearchDatabaseConfig,
  options: WriteVaultNoteOptions,
): Promise<WriteVaultNoteResult> {
  try {
    validateRawWritePath(options.path);
    const relativePath = resolveWritePath(config.vaultPath, options.path);
    const absolutePath = path.join(config.vaultPath, relativePath);

    await ensureLeafSymlinkInsideVault(config.vaultPath, absolutePath);
    const existingMarkdown = await readExistingMarkdownIfPresent(absolutePath);
    const operation = existingMarkdown === undefined ? "created" : "updated";
    const markdown = formatMarkdown(options, existingMarkdown);

    await ensureNearestExistingParentInsideVault(
      config.vaultPath,
      absolutePath,
    );
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await ensureParentInsideVault(config.vaultPath, absolutePath);
    await ensureLeafSymlinkInsideVault(config.vaultPath, absolutePath);
    await writeFile(absolutePath, markdown, "utf8");
    const indexResult = await indexWrittenNote(config, relativePath);

    return {
      path: relativePath,
      operation,
      indexed: indexResult.indexed,
      ...(indexResult.warning === undefined
        ? {}
        : { warning: indexResult.warning }),
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

async function indexWrittenNote(
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

async function readExistingMarkdownIfPresent(
  absolutePath: string,
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
    throw new VaultWriteError("Write path already exists and is not a file");
  }

  return readExistingMarkdownFile(absolutePath);
}

async function readExistingMarkdownFile(absolutePath: string): Promise<string> {
  const content = await readFile(absolutePath);

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new VaultWriteError("Existing markdown file must be readable UTF-8", {
      cause: error,
    });
  }
}

function formatMarkdown(
  options: WriteVaultNoteOptions,
  existingMarkdown: string | undefined,
): string {
  validateBody(options);

  if (options.frontmatter === undefined) {
    if (existingMarkdown === undefined) {
      return options.body;
    }

    const existingFrontmatterPrefix =
      readExistingFrontmatterPrefix(existingMarkdown);
    if (existingFrontmatterPrefix !== undefined) {
      const separator = existingFrontmatterPrefix.endsWith("\n") ? "" : "\n";
      return `${existingFrontmatterPrefix}${separator}${options.body}`;
    }

    return options.body;
  }

  if (!isNonEmptyRecord(options.frontmatter)) {
    return options.body;
  }

  return formatWithFrontmatter(options.frontmatter, options.body);
}

function validateBody(options: WriteVaultNoteOptions): void {
  if (options.body.startsWith("---")) {
    throw new VaultWriteError("Write body must not start with frontmatter");
  }

  if (options.body.trim() !== "" || isNonEmptyRecord(options.frontmatter)) {
    return;
  }

  throw new VaultWriteError(
    "Write body must not be empty unless frontmatter is provided",
  );
}

function readExistingFrontmatterPrefix(markdown: string): string | undefined {
  const firstLineEnd = findLineEnd(markdown, 0);
  const firstLine = markdown.slice(0, firstLineEnd).replace(/\r$/u, "");
  if (firstLine !== "---") {
    return undefined;
  }

  try {
    matter(markdown);
  } catch (error) {
    throw new VaultWriteError("Existing frontmatter is malformed", {
      cause: error,
    });
  }

  return findFrontmatterPrefix(markdown);
}

function findFrontmatterPrefix(markdown: string): string {
  const firstLineEnd = findLineEnd(markdown, 0);
  let lineStart = includeLineBreak(markdown, firstLineEnd);

  while (lineStart < markdown.length) {
    const lineEnd = findLineEnd(markdown, lineStart);
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/u, "");

    if (line === "---" || line === "...") {
      return markdown.slice(0, includeLineBreak(markdown, lineEnd));
    }

    lineStart = includeLineBreak(markdown, lineEnd);
  }

  throw new VaultWriteError("Existing frontmatter is malformed");
}

function findLineEnd(text: string, start: number): number {
  const lineEnd = text.indexOf("\n", start);
  return lineEnd === -1 ? text.length : lineEnd;
}

function includeLineBreak(text: string, lineEnd: number): number {
  return lineEnd < text.length ? lineEnd + 1 : lineEnd;
}

function formatWithFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const formatted = matter.stringify("", frontmatter).replace(/\n\n$/u, "");
  return `${formatted}\n${body}`;
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

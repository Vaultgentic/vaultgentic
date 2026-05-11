import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { SearchDatabaseConfig } from "./database.js";
import { VaultgenticError } from "./errors.js";
import { indexVaultFile } from "./indexer.js";
import {
  ensureLeafSymlinkInsideVault,
  ensureNearestExistingParentInsideVault,
  ensureParentInsideVault,
  readExistingMarkdownIfPresent,
  resolveSafeMarkdownMutationPath,
} from "./markdown-mutation.js";

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
    const { absolutePath, relativePath } = resolveSafeMarkdownMutationPath(
      config.vaultPath,
      options.path,
      VaultWriteError,
    );

    await ensureLeafSymlinkInsideVault(
      config.vaultPath,
      absolutePath,
      VaultWriteError,
    );
    const existingMarkdown = await readExistingMarkdownIfPresent(
      absolutePath,
      VaultWriteError,
    );
    const operation = existingMarkdown === undefined ? "created" : "updated";
    const markdown = formatMarkdown(options, existingMarkdown);

    await ensureNearestExistingParentInsideVault(
      config.vaultPath,
      absolutePath,
      VaultWriteError,
    );
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await ensureParentInsideVault(
      config.vaultPath,
      absolutePath,
      VaultWriteError,
    );
    await ensureLeafSymlinkInsideVault(
      config.vaultPath,
      absolutePath,
      VaultWriteError,
    );
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

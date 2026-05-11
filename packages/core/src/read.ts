import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { ConfigServiceError, resolveVaultRelativePath } from "./config.js";
import type { SearchDatabaseConfig } from "./database.js";
import { VaultgenticError } from "./errors.js";
import { openSearchDatabase } from "./indexer.js";

export type ReadVaultTargetOptions = {
  target: string;
  maxChars?: number;
  withMetadata?: boolean;
  withNoteContext?: boolean;
};

export type ReadVaultTargetResult = ReadVaultNoteResult | ReadVaultChunkResult;

export type ReadVaultNoteResult = {
  type: "note";
  path: string;
  fileHash: string;
  content: string;
  truncated: boolean;
  originalLength: number;
  metadata?: NoteMetadata;
};

export type ReadVaultChunkResult = {
  type: "chunk";
  id: number;
  path: string;
  title: string;
  headingPath: string[];
  chunkIndex: number;
  startLine?: number;
  endLine?: number;
  text: string;
  truncated: boolean;
  originalLength: number;
  noteContext?: NoteMetadata;
};

export type NoteMetadata = {
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  frontmatter: Record<string, unknown>;
  links: Array<Record<string, unknown>>;
  indexedAt: number;
};

export class VaultReadError extends VaultgenticError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultReadError";
  }
}

type NoteMetadataRow = {
  path: string;
  title: string;
  aliasesJson: string | null;
  tagsJson: string | null;
  frontmatterJson: string | null;
  linksJson: string | null;
  indexedAt: number;
};

type ChunkReadRow = NoteMetadataRow & {
  id: number;
  headingPath: string | null;
  chunkIndex: number;
  startLine: number | null;
  endLine: number | null;
  text: string;
};

export async function readVaultTarget(
  config: SearchDatabaseConfig,
  options: ReadVaultTargetOptions,
): Promise<ReadVaultTargetResult> {
  try {
    const target = options.target.trim();

    if (
      options.maxChars !== undefined &&
      (!Number.isInteger(options.maxChars) || options.maxChars < 1)
    ) {
      throw new VaultReadError("Max chars must be a positive integer");
    }

    if (/^\d+$/.test(target)) {
      return readChunkById(config, Number(target), options);
    }

    if (target.endsWith(".md")) {
      return await readNoteByPath(config, target, options);
    }

    throw new VaultReadError(
      `Read target must be a numeric chunk id or vault-relative .md note path: ${options.target}`,
    );
  } catch (error) {
    if (error instanceof VaultReadError) {
      throw error;
    }

    if (error instanceof Error) {
      throw new VaultReadError(
        `Failed to read vault target ${options.target}: ${error.message}`,
        { cause: error },
      );
    }

    throw new VaultReadError(
      `Failed to read vault target ${options.target}: ${String(error)}`,
      { cause: error },
    );
  }
}

async function readNoteByPath(
  config: SearchDatabaseConfig,
  target: string,
  options: ReadVaultTargetOptions,
): Promise<ReadVaultNoteResult> {
  const relativePath = resolveReadPath(config.vaultPath, target);
  const absolutePath = path.join(config.vaultPath, relativePath);
  const content = await readVerifiedVaultFile(
    config.vaultPath,
    absolutePath,
    target,
  );
  const truncatedContent = truncateText(content, options.maxChars);
  const result: ReadVaultNoteResult = {
    type: "note",
    path: relativePath,
    fileHash: hashNoteContent(content),
    content: truncatedContent.text,
    truncated: truncatedContent.truncated,
    originalLength: content.length,
  };

  if (options.withMetadata === true || options.withNoteContext === true) {
    const metadata = readNoteMetadata(config, relativePath);
    if (metadata !== undefined) {
      result.metadata = metadata;
    }
  }

  return result;
}

function resolveReadPath(vaultPath: string, target: string): string {
  try {
    return resolveVaultRelativePath(vaultPath, target);
  } catch (error) {
    if (error instanceof ConfigServiceError) {
      throw new VaultReadError(
        `Invalid read path ${target}: ${error.message}`,
        {
          cause: error,
        },
      );
    }

    throw error;
  }
}

async function readVerifiedVaultFile(
  vaultPath: string,
  absolutePath: string,
  target: string,
): Promise<string> {
  const realVaultPath = await realpath(vaultPath);
  const realCandidatePath = await resolveRealPathInsideVault(
    realVaultPath,
    absolutePath,
    target,
  );
  const pathStat = await readRegularFileStat(realCandidatePath, target);

  const file = await open(
    realCandidatePath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    await ensureOpenHandleInsideVault(file, realVaultPath, pathStat, target);
    return file.readFile("utf8");
  } finally {
    await file.close();
  }
}

async function resolveRealPathInsideVault(
  realVaultPath: string,
  absolutePath: string,
  target: string,
): Promise<string> {
  const realCandidatePath = await realpath(absolutePath).catch(
    (error: unknown) => {
      throw toSafeReadError(error, `Note not found: ${target}`);
    },
  );
  ensurePathInsideVault(realVaultPath, realCandidatePath, target);

  return realCandidatePath;
}

async function readRegularFileStat(
  realCandidatePath: string,
  target: string,
): Promise<Awaited<ReturnType<typeof stat>>> {
  const pathStat = await stat(realCandidatePath).catch((error: unknown) => {
    throw toSafeReadError(error, `Could not inspect note: ${target}`);
  });

  if (!pathStat.isFile()) {
    throw new VaultReadError(`Path must be a regular markdown file: ${target}`);
  }

  return pathStat;
}

function toSafeReadError(error: unknown, message: string): VaultReadError {
  return new VaultReadError(message, { cause: error });
}

async function ensureOpenHandleInsideVault(
  file: FileHandle,
  realVaultPath: string,
  pathStat: Awaited<ReturnType<typeof stat>>,
  target: string,
): Promise<void> {
  const handleStat = await file.stat();

  if (!handleStat.isFile()) {
    throw new VaultReadError(`Path must be a regular markdown file: ${target}`);
  }

  if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
    throw new VaultReadError(
      `Path changed while reading from the vault: ${target}`,
    );
  }

  if (process.platform === "linux") {
    const realHandlePath = await realpath(`/proc/self/fd/${file.fd}`);
    ensurePathInsideVault(realVaultPath, realHandlePath, target);
  }
}

function ensurePathInsideVault(
  realVaultPath: string,
  candidatePath: string,
  target: string,
): void {
  const relativePath = path.relative(realVaultPath, candidatePath);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new VaultReadError(`Path must stay inside the vault: ${target}`);
  }
}

function readChunkById(
  config: SearchDatabaseConfig,
  chunkId: number,
  options: ReadVaultTargetOptions,
): ReadVaultChunkResult {
  const database = openSearchDatabase(config);
  try {
    const row = database
      .prepare(
        `
          SELECT
            c.id,
            c.path,
            c.title,
            c.heading_path AS headingPath,
            c.chunk_index AS chunkIndex,
            c.start_line AS startLine,
            c.end_line AS endLine,
            c.text,
            n.aliases_json AS aliasesJson,
            n.tags_json AS tagsJson,
            n.frontmatter_json AS frontmatterJson,
            n.links_json AS linksJson,
            n.indexed_at AS indexedAt
          FROM chunks c
          JOIN notes n ON n.id = c.note_id
          WHERE c.id = ?
        `,
      )
      .get(chunkId) as ChunkReadRow | undefined;

    if (row === undefined) {
      throw new VaultReadError(`Chunk not found: ${chunkId}`);
    }

    const truncatedText = truncateText(row.text, options.maxChars);
    const result: ReadVaultChunkResult = {
      type: "chunk",
      id: row.id,
      path: row.path,
      title: row.title,
      headingPath: parseHeadingPath(row.headingPath),
      chunkIndex: row.chunkIndex,
      startLine: row.startLine ?? undefined,
      endLine: row.endLine ?? undefined,
      text: truncatedText.text,
      truncated: truncatedText.truncated,
      originalLength: row.text.length,
    };

    if (options.withMetadata === true || options.withNoteContext === true) {
      result.noteContext = metadataFromRow(row);
    }

    return result;
  } finally {
    database.close();
  }
}

function readNoteMetadata(
  config: SearchDatabaseConfig,
  relativePath: string,
): NoteMetadata | undefined {
  const database = openSearchDatabase(config);
  try {
    const row = database
      .prepare(
        `
          SELECT
            path,
            title,
            aliases_json AS aliasesJson,
            tags_json AS tagsJson,
            frontmatter_json AS frontmatterJson,
            links_json AS linksJson,
            indexed_at AS indexedAt
          FROM notes
          WHERE path = ?
        `,
      )
      .get(relativePath) as NoteMetadataRow | undefined;

    return row === undefined ? undefined : metadataFromRow(row);
  } finally {
    database.close();
  }
}

function truncateText(
  text: string,
  maxChars: number | undefined,
): { text: string; truncated: boolean } {
  if (maxChars === undefined || text.length <= maxChars) {
    return { text, truncated: false };
  }

  if (maxChars === 1) {
    return { text: "…", truncated: true };
  }

  const truncatedText = text.slice(0, maxChars - 1);
  const readableText = trimToReadableBoundary(
    truncatedText,
    text[maxChars - 1],
  );

  return { text: `${readableText}…`, truncated: true };
}

function hashNoteContent(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function trimToReadableBoundary(text: string, nextCharacter: string): string {
  const trimmedText = text.trimEnd();

  if (trimmedText.length < text.length) {
    return trimmedText;
  }

  if (/\s/u.test(nextCharacter)) {
    return trimmedText;
  }

  const boundaryIndex = trimmedText.search(/\s+\S*$/u);

  if (boundaryIndex <= 0) {
    return trimmedText;
  }

  return trimmedText.slice(0, boundaryIndex);
}

function metadataFromRow(row: NoteMetadataRow): NoteMetadata {
  return {
    path: row.path,
    title: row.title,
    aliases: parseJson(row.aliasesJson, []),
    tags: parseJson(row.tagsJson, []),
    frontmatter: parseJson(row.frontmatterJson, {}),
    links: parseJson(row.linksJson, []),
    indexedAt: row.indexedAt,
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null || value === "") {
    return fallback;
  }

  return JSON.parse(value) as T;
}

function parseHeadingPath(headingPath: string | null): string[] {
  if (headingPath === null || headingPath === "") {
    return [];
  }

  return headingPath.split(" / ");
}

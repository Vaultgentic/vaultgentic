import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { ConfigServiceError, resolveVaultRelativePath } from "./config.js";
import {
  type DatabaseStatus,
  type SearchDatabaseConfig,
  chunkerVersion,
  initializeSearchDatabase,
  loadSqliteVec,
  resetEmbeddingStorage,
  schemaVersion,
} from "./database.js";
import {
  embedChunkText,
  embedQueryText,
  embeddingModelMetadata,
} from "./embedding.js";
import type { EmbeddingResult } from "./embedding.js";
import { VaultgenticError } from "./errors.js";
import {
  type MarkdownChunk,
  type ParsedMarkdownNote,
  chunkMarkdownNote,
  parseMarkdownNote,
} from "./markdown.js";
import { type VaultFileMetadata, scanVaultFiles } from "./scanner.js";

export type IndexFileResult = {
  path: string;
  status: "indexed" | "skipped";
  chunkCount: number;
};

export type SyncSearchIndexResult = {
  indexed: number;
  skipped: number;
  deleted: number;
  files: IndexFileResult[];
  deletedPaths: string[];
};

export type RemoveIndexedPathResult = {
  path: string;
  deleted: boolean;
};

export type RefreshSearchIndexResult = {
  sync: SyncSearchIndexResult;
  status: DatabaseStatus;
};

export type RebuildSearchIndexResult = {
  indexed: number;
  skipped: 0;
  deleted: number;
  files: IndexFileResult[];
  status: DatabaseStatus;
};

export type IndexProgressPhase =
  | "scanning"
  | "parsing"
  | "embedding"
  | "writing"
  | "deleting";

export type IndexProgressEvent = {
  phase: IndexProgressPhase;
  message: string;
  current?: number;
  total?: number;
  path?: string;
};

export type IndexProgressOptions = {
  onProgress?: (event: IndexProgressEvent) => void;
};

export type Bm25SearchResult = {
  chunkId: number;
  path: string;
  title: string;
  headingPath: string[];
  snippet: string;
  score: number;
  rank: number;
  chunkIndex: number;
  startLine?: number;
  endLine?: number;
};

export type SemanticSearchResult = {
  chunkId: number;
  path: string;
  title: string;
  headingPath: string[];
  snippet: string;
  score: number;
  rank: number;
  chunkIndex: number;
  startLine?: number;
  endLine?: number;
};

export type TitleSearchResult = {
  path: string;
  title: string;
  aliases: string[];
  snippet?: string;
  score: number;
  rank: number;
};

export type SearchFilterDiagnostics = {
  appliedFilters: {
    scope?: string;
    tags: string[];
  };
  matchedNoteCounts: {
    allFilters: number;
    scope?: number;
    tags: Record<string, number>;
  };
  warnings: string[];
};

type SearchFilterOptions = {
  scope?: string;
  tags?: string[];
};

export class SearchIndexerError extends VaultgenticError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SearchIndexerError";
  }
}

type ExistingNoteRow = {
  mtimeMs: number;
  sizeBytes: number;
  contentHash: string;
};

type SearchRow = {
  chunkId: number;
  path: string;
  title: string;
  headingPath: string | null;
  snippet: string;
  score: number;
  chunkIndex: number;
  startLine: number | null;
  endLine: number | null;
};

type SemanticSearchRow = {
  chunkId: number;
  path: string;
  title: string;
  headingPath: string | null;
  snippet: string;
  score: number;
  chunkIndex: number;
  startLine: number | null;
  endLine: number | null;
};

type TitleSearchRow = {
  id: number;
  path: string;
  title: string;
  aliasesJson: string | null;
  snippet: string | null;
};

type FtsChunkRow = {
  id: number;
  headingPath: string | null;
  text: string;
};

type VectorChunkRow = {
  id: number;
  title: string;
  headingPath: string | null;
  text: string;
};

type PreparedIndexedFile = {
  metadata: VaultFileMetadata & { content_hash: string };
  note: ParsedMarkdownNote;
  chunks: PreparedMarkdownChunk[];
};

type PreparedMarkdownChunk = {
  chunk: MarkdownChunk;
  embedding: EmbeddingResult;
};

type WrittenChunkEmbedding = {
  chunkId: bigint;
  embedding: EmbeddingResult;
};

export function openSearchDatabase(
  config: SearchDatabaseConfig,
  options: { skipEmbeddingMetadataValidation?: boolean } = {},
): Database.Database {
  initializeSearchDatabase(config, options);
  const database = new Database(config.databasePath);
  loadSqliteVec(database);
  database.pragma("foreign_keys = ON");
  return database;
}

export async function indexVaultFile(
  config: SearchDatabaseConfig,
  vaultRelativePath: string,
  options: IndexProgressOptions = {},
): Promise<IndexFileResult> {
  try {
    const relativePath = resolveIndexPath(config.vaultPath, vaultRelativePath);
    const absolutePath = path.join(config.vaultPath, relativePath);
    emitIndexProgress(options, {
      phase: "scanning",
      message: `Reading ${relativePath}`,
      path: relativePath,
    });
    const [fileStat, content] = await Promise.all([
      stat(absolutePath),
      readFile(absolutePath, "utf8"),
    ]);
    const metadata = {
      path: relativePath,
      mtime_ms: Math.trunc(fileStat.mtimeMs),
      size_bytes: fileStat.size,
      content_hash: hashContent(content),
    };

    const database = openSearchDatabase(config);
    try {
      return await indexFileContent(database, metadata, content, options, {
        current: 1,
        total: 1,
      });
    } finally {
      database.close();
    }
  } catch (error) {
    throw toSearchIndexerError(
      `Failed to index vault file ${vaultRelativePath}`,
      error,
    );
  }
}

export function removeIndexedVaultPath(
  config: SearchDatabaseConfig,
  vaultRelativePath: string,
): RemoveIndexedPathResult {
  let database: Database.Database | undefined;
  try {
    const relativePath = resolveIndexPath(config.vaultPath, vaultRelativePath);
    database = openSearchDatabase(config);
    const activeDatabase = database;
    const deleted = activeDatabase.transaction(() =>
      deleteIndexedPath(activeDatabase, relativePath),
    )();

    return { path: relativePath, deleted };
  } catch (error) {
    throw toSearchIndexerError(
      `Failed to remove indexed vault path ${vaultRelativePath}`,
      error,
    );
  } finally {
    database?.close();
  }
}

function resolveIndexPath(
  vaultPath: string,
  vaultRelativePath: string,
): string {
  try {
    return resolveVaultRelativePath(vaultPath, vaultRelativePath);
  } catch (error) {
    if (error instanceof ConfigServiceError) {
      throw new SearchIndexerError(
        `Invalid index path ${vaultRelativePath}: ${error.message}`,
        { cause: error },
      );
    }

    throw error;
  }
}

export async function syncSearchIndex(
  config: SearchDatabaseConfig,
  options: IndexProgressOptions = {},
): Promise<SyncSearchIndexResult> {
  let database: Database.Database | undefined;
  try {
    emitIndexProgress(options, {
      phase: "scanning",
      message: "Scanning vault",
    });
    const files = await scanVaultFiles(config, { includeContentHash: true });
    emitIndexProgress(options, {
      phase: "scanning",
      message: `Found ${files.length} markdown ${files.length === 1 ? "file" : "files"}`,
      current: files.length,
      total: files.length,
    });
    database = openSearchDatabase(config);
    const result: SyncSearchIndexResult = {
      indexed: 0,
      skipped: 0,
      deleted: 0,
      files: [],
      deletedPaths: [],
    };
    const currentPaths = new Set(files.map((file) => file.path));

    for (const [index, file] of files.entries()) {
      const fileProgress = { current: index + 1, total: files.length };
      emitIndexProgress(options, {
        phase: "scanning",
        message: `Checking ${file.path}`,
        ...fileProgress,
        path: file.path,
      });
      if (file.content_hash === undefined) {
        throw new SearchIndexerError(
          `Missing content hash for scanned file: ${file.path}`,
        );
      }

      const currentResult = await indexCurrentFile(
        database,
        {
          ...file,
          content_hash: file.content_hash,
        },
        options,
        fileProgress,
      );
      if (currentResult !== undefined) {
        result.files.push(currentResult);
        if (currentResult.status === "indexed") {
          result.indexed += 1;
        } else {
          result.skipped += 1;
        }
        continue;
      }

      const content = await readFile(
        path.join(config.vaultPath, file.path),
        "utf8",
      );
      const fileResult = await indexFileContent(
        database,
        { ...file, content_hash: file.content_hash },
        content,
        options,
        fileProgress,
      );
      result.files.push(fileResult);
      if (fileResult.status === "indexed") {
        result.indexed += 1;
      } else {
        result.skipped += 1;
      }
    }

    for (const indexedPath of readIndexedPaths(database)) {
      if (!currentPaths.has(indexedPath)) {
        emitIndexProgress(options, {
          phase: "deleting",
          message: `Deleting stale index entry ${indexedPath}`,
          path: indexedPath,
        });
        deleteIndexedPath(database, indexedPath);
        result.deleted += 1;
        result.deletedPaths.push(indexedPath);
      }
    }

    return result;
  } catch (error) {
    throw toSearchIndexerError("Failed to sync search index", error);
  } finally {
    database?.close();
  }
}

export async function refreshSearchIndex(
  config: SearchDatabaseConfig,
  options: IndexProgressOptions = {},
): Promise<RefreshSearchIndexResult> {
  const sync = await syncSearchIndex(config, options);
  const status = initializeSearchDatabase(config);

  return { sync, status };
}

export async function rebuildSearchIndex(
  config: SearchDatabaseConfig,
  options: IndexProgressOptions = {},
): Promise<RebuildSearchIndexResult> {
  let database: Database.Database | undefined;
  try {
    emitIndexProgress(options, {
      phase: "scanning",
      message: "Scanning vault",
    });
    const files = await scanVaultFiles(config, { includeContentHash: true });
    emitIndexProgress(options, {
      phase: "scanning",
      message: `Found ${files.length} markdown ${files.length === 1 ? "file" : "files"}`,
      current: files.length,
      total: files.length,
    });
    const preparedFiles: PreparedIndexedFile[] = [];

    for (const [index, file] of files.entries()) {
      const fileProgress = { current: index + 1, total: files.length };
      if (file.content_hash === undefined) {
        throw new SearchIndexerError(
          `Missing content hash for scanned file: ${file.path}`,
        );
      }

      const content = await readFile(
        path.join(config.vaultPath, file.path),
        "utf8",
      );
      preparedFiles.push(
        await prepareFileContent(
          { ...file, content_hash: file.content_hash },
          content,
          options,
          fileProgress,
        ),
      );
    }

    database = openSearchDatabase(config, {
      skipEmbeddingMetadataValidation: true,
    });
    const activeDatabase = database;
    ensureFtsTable(activeDatabase);
    const currentPaths = new Set(files.map((file) => file.path));
    const deleted = readIndexedPaths(activeDatabase).filter(
      (indexedPath) => !currentPaths.has(indexedPath),
    ).length;
    const now = Date.now();
    const indexedFiles: IndexFileResult[] = [];

    activeDatabase.transaction(() => {
      resetEmbeddingStorage(activeDatabase);
      clearIndexedContent(activeDatabase);

      for (const [index, preparedFile] of preparedFiles.entries()) {
        emitIndexProgress(options, {
          phase: "writing",
          message: `Writing ${preparedFile.metadata.path}`,
          current: index + 1,
          total: preparedFiles.length,
          path: preparedFile.metadata.path,
        });
        const writtenChunks = writePreparedFile(
          activeDatabase,
          preparedFile,
          now,
        );
        writeChunkEmbeddings(activeDatabase, writtenChunks);
        indexedFiles.push({
          path: preparedFile.metadata.path,
          status: "indexed",
          chunkCount: preparedFile.chunks.length,
        });
      }
    })();

    return {
      indexed: indexedFiles.length,
      skipped: 0,
      deleted,
      files: indexedFiles,
      status: readDatabaseStatus(activeDatabase, config),
    };
  } catch (error) {
    throw toSearchIndexerError("Failed to rebuild search index", error);
  } finally {
    database?.close();
  }
}

export function searchBm25(
  config: SearchDatabaseConfig,
  options: { query: string; limit?: number } & SearchFilterOptions,
): Bm25SearchResult[] {
  const query = options.query.trim();
  if (query === "") {
    return [];
  }

  let database: Database.Database | undefined;
  try {
    database = openSearchDatabase(config);
    ensureFtsTable(database);
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === "") {
      return [];
    }

    const filters = buildSearchFilterSql("n", options);
    const finalLimit = normalizeSearchLimit(options.limit);
    const rows = executeBm25Search(database, ftsQuery, filters, finalLimit);
    const fallbackRows =
      rows.length === 0
        ? executeBm25Search(
            database,
            buildRelaxedFtsQuery(query),
            filters,
            finalLimit,
          )
        : rows;

    return fallbackRows.map((row, index) => ({
      path: row.path,
      chunkId: row.chunkId,
      title: row.title,
      headingPath: parseHeadingPath(row.headingPath),
      snippet: row.snippet,
      score: row.score,
      rank: index + 1,
      chunkIndex: row.chunkIndex,
      startLine: row.startLine ?? undefined,
      endLine: row.endLine ?? undefined,
    }));
  } catch (error) {
    throw toSearchIndexerError("Failed to search BM25 index", error);
  } finally {
    database?.close();
  }
}

function executeBm25Search(
  database: Database.Database,
  ftsQuery: string,
  filters: { sql: string; params: string[] },
  limit: number,
): SearchRow[] {
  if (ftsQuery === "") return [];

  return database
    .prepare(
      `
        SELECT
          c.id AS chunkId,
          c.path,
          c.title,
          c.heading_path AS headingPath,
          c.chunk_index AS chunkIndex,
          c.start_line AS startLine,
          c.end_line AS endLine,
          snippet(chunks_fts, 3, '', '', '…', 32) AS snippet,
          bm25(chunks_fts) AS score
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        JOIN notes n ON n.path = c.path
        WHERE chunks_fts MATCH ?${filters.sql}
        ORDER BY score ASC
        LIMIT ?
      `,
    )
    .all(ftsQuery, ...filters.params, limit) as SearchRow[];
}

export async function searchSemantic(
  config: SearchDatabaseConfig,
  options: { query: string; limit?: number } & SearchFilterOptions,
): Promise<SemanticSearchResult[]> {
  const query = options.query.trim();
  if (query === "") {
    return [];
  }

  let database: Database.Database | undefined;
  try {
    database = openSearchDatabase(config);
    ensureVectorTable(database);
    const embedding = await embedQueryText(query);
    validateEmbeddingMetadata(embedding);
    const filters = buildSearchFilterSql("n", options);
    const finalLimit = normalizeSearchLimit(options.limit);
    const rows = database
      .prepare(
        `
          SELECT
            c.id AS chunkId,
            c.path,
            c.title,
            c.heading_path AS headingPath,
            c.chunk_index AS chunkIndex,
            c.start_line AS startLine,
            c.end_line AS endLine,
            c.text AS snippet,
            chunk_embeddings.distance AS score
          FROM chunk_embeddings
          JOIN chunks c ON c.id = chunk_embeddings.rowid
          JOIN notes n ON n.path = c.path
          WHERE chunk_embeddings.embedding MATCH ? AND k = ?${filters.sql}
          ORDER BY score ASC
        `,
      )
      .all(
        toVectorBuffer(embedding.vector),
        filters.sql === ""
          ? finalLimit
          : Math.min(100, Math.max(finalLimit * 10, finalLimit)),
        ...filters.params,
      ) as SemanticSearchRow[];

    return rows.slice(0, finalLimit).map((row, index) => ({
      path: row.path,
      chunkId: row.chunkId,
      title: row.title,
      headingPath: parseHeadingPath(row.headingPath),
      snippet: formatSemanticSnippet(row.snippet),
      score: row.score,
      rank: index + 1,
      chunkIndex: row.chunkIndex,
      startLine: row.startLine ?? undefined,
      endLine: row.endLine ?? undefined,
    }));
  } catch (error) {
    throw toSearchIndexerError("Failed to search semantic index", error);
  } finally {
    database?.close();
  }
}

export function searchTitles(
  config: SearchDatabaseConfig,
  options: { query: string; limit?: number } & SearchFilterOptions,
): TitleSearchResult[] {
  const query = options.query.trim();
  if (query === "") {
    return [];
  }

  let database: Database.Database | undefined;
  try {
    database = openSearchDatabase(config);
    ensureTitleFtsTable(database);
    const ftsQuery = buildTitleFtsQuery(query);
    const candidateIds =
      ftsQuery === "" ? [] : readTitleSearchCandidateIds(database, ftsQuery);
    const filters = buildSearchFilterSql("notes", options);
    const whereParts = [
      ...(candidateIds.length > 0
        ? [`id IN (${candidateIds.map(() => "?").join(", ")})`]
        : []),
      ...(filters.sql === "" ? [] : [filters.sql.slice(5)]),
    ];
    const rows = database
      .prepare(
        `
          SELECT
            id,
            path,
            title,
            aliases_json AS aliasesJson,
            (
              SELECT text
              FROM chunks
              WHERE chunks.path = notes.path
              ORDER BY chunk_index
              LIMIT 1
            ) AS snippet
          FROM notes
          ${whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : ""}
          ORDER BY path
        `,
      )
      .all(...candidateIds, ...filters.params) as TitleSearchRow[];
    const scored = rows
      .map((row) => {
        const aliases = parseAliases(row.aliasesJson);
        const score = scoreTitleMatch(query, row.title, aliases, row.path);
        return { row, aliases, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.row.path.localeCompare(right.row.path);
      })
      .slice(0, normalizeSearchLimit(options.limit));

    return scored.map((entry, index) => ({
      path: entry.row.path,
      title: entry.row.title,
      aliases: entry.aliases,
      ...(entry.row.snippet === null
        ? {}
        : { snippet: formatSemanticSnippet(entry.row.snippet) }),
      score: entry.score,
      rank: index + 1,
    }));
  } catch (error) {
    throw toSearchIndexerError("Failed to search note titles", error);
  } finally {
    database?.close();
  }
}

export function readSearchFilterDiagnostics(
  config: SearchDatabaseConfig,
  options: SearchFilterOptions,
): SearchFilterDiagnostics {
  const tags = options.tags ?? [];
  let database: Database.Database | undefined;
  try {
    database = openSearchDatabase(config);
    const activeDatabase = database;
    const filters = buildSearchFilterSql("notes", options);
    const allFilters = readFilteredNoteCount(activeDatabase, filters);
    const scope =
      options.scope === undefined
        ? undefined
        : readFilteredNoteCount(
            activeDatabase,
            buildSearchFilterSql("notes", {
              scope: options.scope,
            }),
          );
    const tagCounts = Object.fromEntries(
      tags.map((tag) => [
        tag,
        readFilteredNoteCount(
          activeDatabase,
          buildSearchFilterSql("notes", { tags: [tag] }),
        ),
      ]),
    );
    const individualWarnings = [
      ...(options.scope !== undefined && scope === 0
        ? [`No indexed notes match scope: ${options.scope}`]
        : []),
      ...Object.entries(tagCounts)
        .filter(([, count]) => count === 0)
        .map(([tag]) => `No indexed notes match tag: ${tag}`),
    ];
    const appliedFilterCount =
      (options.scope === undefined ? 0 : 1) + tags.length;
    const warnings = [
      ...individualWarnings,
      ...(allFilters === 0 &&
      appliedFilterCount > 1 &&
      individualWarnings.length === 0
        ? ["No indexed notes match all applied filters"]
        : []),
    ];

    return {
      appliedFilters: { scope: options.scope, tags },
      matchedNoteCounts: {
        allFilters,
        ...(scope === undefined ? {} : { scope }),
        tags: tagCounts,
      },
      warnings,
    };
  } catch (error) {
    throw toSearchIndexerError(
      "Failed to read search filter diagnostics",
      error,
    );
  } finally {
    database?.close();
  }
}

function toSearchIndexerError(
  message: string,
  error: unknown,
): SearchIndexerError {
  if (error instanceof SearchIndexerError) {
    return error;
  }

  if (error instanceof Error) {
    return new SearchIndexerError(`${message}: ${error.message}`, {
      cause: error,
    });
  }

  return new SearchIndexerError(`${message}: ${String(error)}`, {
    cause: error,
  });
}

function emitIndexProgress(
  options: IndexProgressOptions,
  event: IndexProgressEvent,
): void {
  options.onProgress?.(event);
}

async function indexFileContent(
  database: Database.Database,
  metadata: VaultFileMetadata & { content_hash: string },
  content: string,
  options: IndexProgressOptions = {},
  fileProgress?: { current: number; total: number },
): Promise<IndexFileResult> {
  const existing = readExistingNote(database, metadata.path);

  if (isExistingNoteCurrent(existing, metadata)) {
    const currentResult = await indexCurrentFile(
      database,
      metadata,
      options,
      fileProgress,
    );
    if (currentResult !== undefined) {
      return currentResult;
    }
  }

  ensureFtsTable(database);
  ensureVectorTable(database);
  const preparedFile = await prepareFileContent(
    metadata,
    content,
    options,
    fileProgress,
  );
  const now = Date.now();

  database.transaction(() => {
    emitIndexProgress(options, {
      phase: "writing",
      message: `Writing ${metadata.path}`,
      ...fileProgress,
      path: metadata.path,
    });
    deleteIndexedPath(database, metadata.path);
    const writtenChunks = writePreparedFile(database, preparedFile, now);
    writeChunkEmbeddings(database, writtenChunks);
  })();

  return {
    path: metadata.path,
    status: "indexed",
    chunkCount: preparedFile.chunks.length,
  };
}

async function prepareFileContent(
  metadata: VaultFileMetadata & { content_hash: string },
  content: string,
  options: IndexProgressOptions = {},
  fileProgress?: { current: number; total: number },
): Promise<PreparedIndexedFile> {
  emitIndexProgress(options, {
    phase: "parsing",
    message: `Parsing ${metadata.path}`,
    ...fileProgress,
    path: metadata.path,
  });
  const note = parseMarkdownNote({ path: metadata.path, content });
  emitIndexProgress(options, {
    phase: "embedding",
    message: `Embedding ${metadata.path}`,
    ...fileProgress,
    path: metadata.path,
  });
  const chunks = await Promise.all(
    chunkMarkdownNote(note).map(async (chunk) => ({
      chunk,
      embedding: await embedChunkText(buildChunkSearchContext(chunk)),
    })),
  );

  return {
    metadata,
    note,
    chunks,
  };
}

function writePreparedFile(
  database: Database.Database,
  preparedFile: PreparedIndexedFile,
  now: number,
): WrittenChunkEmbedding[] {
  const { metadata, note, chunks } = preparedFile;
  const writtenChunks: WrittenChunkEmbedding[] = [];
  const noteResult = database
    .prepare(
      `
        INSERT INTO notes (
          path, title, aliases_json, tags_json, frontmatter_json, links_json,
          mtime_ms, size_bytes, content_hash, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      note.path,
      note.title,
      JSON.stringify(note.aliases),
      JSON.stringify(note.tags),
      JSON.stringify(note.frontmatter),
      JSON.stringify(note.links),
      metadata.mtime_ms,
      metadata.size_bytes,
      metadata.content_hash,
      now,
    );
  const noteId = Number(noteResult.lastInsertRowid);
  const insertChunk = database.prepare(
    `
      INSERT INTO chunks (
        note_id, chunk_index, path, title, heading_path, start_line, end_line,
        text, token_estimate, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const insertNoteFts = database.prepare(
    `
      INSERT INTO notes_fts (rowid, path, title, aliases)
      VALUES (?, ?, ?, ?)
    `,
  );
  const insertFts = database.prepare(
    `
      INSERT INTO chunks_fts (rowid, path, title, heading_path, text)
      VALUES (?, ?, ?, ?, ?)
    `,
  );
  insertNoteFts.run(noteId, note.path, note.title, note.aliases.join(" "));

  for (const preparedChunk of chunks) {
    const { chunk, embedding } = preparedChunk;
    const headingPath = chunk.headingPath.join(" / ");
    const chunkResult = insertChunk.run(
      noteId,
      chunk.index,
      chunk.path,
      chunk.title,
      headingPath,
      chunk.start_line ?? null,
      chunk.end_line ?? null,
      chunk.text,
      estimateTokens(chunk.text),
      chunk.content_hash,
      now,
    );
    insertFts.run(
      Number(chunkResult.lastInsertRowid),
      "",
      "",
      headingPath,
      chunk.text,
    );
    writtenChunks.push({
      chunkId: BigInt(chunkResult.lastInsertRowid),
      embedding,
    });
  }

  return writtenChunks;
}

async function indexCurrentFile(
  database: Database.Database,
  metadata: VaultFileMetadata & { content_hash: string },
  options: IndexProgressOptions = {},
  fileProgress?: { current: number; total: number },
): Promise<IndexFileResult | undefined> {
  const existing = readExistingNote(database, metadata.path);
  if (!isExistingNoteCurrent(existing, metadata)) {
    return undefined;
  }

  const chunkCount = readChunkCount(database, metadata.path);
  if (
    readFtsCount(database, metadata.path) === chunkCount &&
    readTitleFtsCount(database, metadata.path) === 1 &&
    readVectorCount(database, metadata.path) === chunkCount
  ) {
    return { path: metadata.path, status: "skipped", chunkCount };
  }

  ensureFtsTable(database);
  ensureTitleFtsTable(database);
  ensureVectorTable(database);
  emitIndexProgress(options, {
    phase: "embedding",
    message: `Embedding ${metadata.path}`,
    ...fileProgress,
    path: metadata.path,
  });
  const vectorChunks = await prepareExistingChunkEmbeddings(
    database,
    metadata.path,
  );
  emitIndexProgress(options, {
    phase: "writing",
    message: `Writing ${metadata.path}`,
    ...fileProgress,
    path: metadata.path,
  });
  backfillTitleFtsRow(database, metadata.path);
  backfillFtsRows(database, metadata.path);
  writeChunkEmbeddings(database, vectorChunks);
  return { path: metadata.path, status: "indexed", chunkCount };
}

function readExistingNote(
  database: Database.Database,
  indexedPath: string,
): ExistingNoteRow | undefined {
  return database
    .prepare(
      `
        SELECT mtime_ms AS mtimeMs, size_bytes AS sizeBytes, content_hash AS contentHash
        FROM notes
        WHERE path = ?
      `,
    )
    .get(indexedPath) as ExistingNoteRow | undefined;
}

function isExistingNoteCurrent(
  existing: ExistingNoteRow | undefined,
  metadata: VaultFileMetadata & { content_hash: string },
): boolean {
  return (
    existing !== undefined &&
    existing.mtimeMs === metadata.mtime_ms &&
    existing.sizeBytes === metadata.size_bytes &&
    existing.contentHash === metadata.content_hash
  );
}

function deleteIndexedPath(
  database: Database.Database,
  indexedPath: string,
): boolean {
  const noteIds = database
    .prepare("SELECT id FROM notes WHERE path = ?")
    .all(indexedPath) as Array<{ id: number }>;
  const deleted = noteIds.length > 0;
  const chunkIds = database
    .prepare("SELECT id FROM chunks WHERE path = ?")
    .all(indexedPath) as Array<{ id: number }>;
  const deleteNoteFts = database.prepare(
    "DELETE FROM notes_fts WHERE rowid = ?",
  );
  const deleteFts = database.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
  const deleteVector = hasTable(database, "chunk_embeddings")
    ? database.prepare("DELETE FROM chunk_embeddings WHERE rowid = ?")
    : undefined;
  for (const note of noteIds) {
    deleteNoteFts.run(note.id);
  }
  for (const chunk of chunkIds) {
    deleteFts.run(chunk.id);
    deleteVector?.run(BigInt(chunk.id));
  }
  database.prepare("DELETE FROM notes WHERE path = ?").run(indexedPath);

  return deleted;
}

function clearIndexedContent(database: Database.Database): void {
  if (hasTable(database, "chunk_embeddings")) {
    database.prepare("DELETE FROM chunk_embeddings").run();
  }
  database.prepare("DELETE FROM notes_fts").run();
  database.prepare("DELETE FROM chunks_fts").run();
  database.prepare("DELETE FROM chunks").run();
  database.prepare("DELETE FROM notes").run();
}

function readDatabaseStatus(
  database: Database.Database,
  config: SearchDatabaseConfig,
): DatabaseStatus {
  const sqliteVecAvailable = isSqliteVecAvailable(database);

  return {
    vaultPath: config.vaultPath,
    databasePath: config.databasePath,
    schemaVersion,
    noteCount: readCount(database, "notes"),
    chunkCount: readCount(database, "chunks"),
    lastIndexedAt: readLastIndexedAt(database),
    sqlite: {
      ok: true,
      walEnabled: readJournalMode(database) === "wal",
      foreignKeysEnabled: readForeignKeys(database),
      fts5Available: true,
      sqliteVecAvailable,
    },
    vectors: {
      ready: sqliteVecAvailable && hasTable(database, "chunk_embeddings"),
      chunkEmbeddingCount: readVectorCount(database),
      modelId: embeddingModelMetadata.modelId,
      dimension: embeddingModelMetadata.dimension,
      normalized: embeddingModelMetadata.normalized,
      chunkerVersion,
    },
  };
}

function readIndexedPaths(database: Database.Database): string[] {
  return database
    .prepare("SELECT path FROM notes ORDER BY path")
    .all()
    .map((row) => (row as { path: string }).path);
}

function readChunkCount(
  database: Database.Database,
  indexedPath: string,
): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM chunks WHERE path = ?")
    .get(indexedPath) as { count: number };
  return row.count;
}

function readVectorCount(
  database: Database.Database,
  indexedPath?: string,
): number {
  if (!hasTable(database, "chunk_embeddings")) {
    return 0;
  }

  if (indexedPath === undefined) {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM chunk_embeddings")
      .get() as { count: number };
    return row.count;
  }

  const row = database
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM chunk_embeddings
        JOIN chunks c ON c.id = chunk_embeddings.rowid
        WHERE c.path = ?
      `,
    )
    .get(indexedPath) as { count: number };
  return row.count;
}

function readCount(
  database: Database.Database,
  tableName: "notes" | "chunks",
): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get() as { count: number };
  return row.count;
}

function readLastIndexedAt(database: Database.Database): number | null {
  const row = database
    .prepare("SELECT MAX(indexed_at) AS lastIndexedAt FROM notes")
    .get() as { lastIndexedAt: number | null };
  return row.lastIndexedAt;
}

function readJournalMode(database: Database.Database): string {
  const row = database.pragma("journal_mode", { simple: true }) as string;
  return row.toLowerCase();
}

function readForeignKeys(database: Database.Database): boolean {
  return database.pragma("foreign_keys", { simple: true }) === 1;
}

function isSqliteVecAvailable(database: Database.Database): boolean {
  try {
    database.prepare("SELECT vec_version() AS version").get();
    return true;
  } catch {
    return false;
  }
}

function ensureVectorTable(database: Database.Database): void {
  if (
    isSqliteVecAvailable(database) &&
    hasTable(database, "chunk_embeddings")
  ) {
    return;
  }

  throw new SearchIndexerError(
    "sqlite-vec is not available for chunk embedding storage",
  );
}

async function prepareExistingChunkEmbeddings(
  database: Database.Database,
  indexedPath: string,
): Promise<WrittenChunkEmbedding[]> {
  const chunks = database
    .prepare(
      `
        SELECT id, title, heading_path AS headingPath, text
        FROM chunks
        WHERE path = ?
        ORDER BY chunk_index
      `,
    )
    .all(indexedPath) as VectorChunkRow[];

  return await Promise.all(
    chunks.map(async (chunk) => ({
      chunkId: BigInt(chunk.id),
      embedding: await embedChunkText(
        buildChunkSearchContext({
          title: chunk.title,
          headingPath: parseHeadingPath(chunk.headingPath),
          text: chunk.text,
        }),
      ),
    })),
  );
}

function buildChunkSearchContext(chunk: {
  title: string;
  headingPath: string[];
  text: string;
}): string {
  return [
    `Title: ${chunk.title}`,
    chunk.headingPath.length > 0
      ? `Headings: ${chunk.headingPath.join(" > ")}`
      : undefined,
    chunk.text,
  ]
    .filter((line) => line !== undefined && line !== "")
    .join("\n\n");
}

function writeChunkEmbeddings(
  database: Database.Database,
  chunks: WrittenChunkEmbedding[],
): void {
  ensureVectorTable(database);
  const deleteEmbedding = database.prepare(
    "DELETE FROM chunk_embeddings WHERE rowid = ?",
  );
  const insertEmbedding = database.prepare(
    "INSERT INTO chunk_embeddings(rowid, embedding) VALUES (?, ?)",
  );

  for (const chunk of chunks) {
    validateEmbeddingMetadata(chunk.embedding);
    deleteEmbedding.run(chunk.chunkId);
    insertEmbedding.run(chunk.chunkId, toVectorBuffer(chunk.embedding.vector));
  }
}

function validateEmbeddingMetadata(embedding: EmbeddingResult): void {
  if (
    embedding.metadata.modelId !== embeddingModelMetadata.modelId ||
    embedding.metadata.dimension !== embeddingModelMetadata.dimension ||
    embedding.metadata.normalized !== embeddingModelMetadata.normalized ||
    embedding.vector.length !== embeddingModelMetadata.dimension
  ) {
    throw new SearchIndexerError(
      "Embedding metadata does not match the configured sqlite-vec table; full reindex required",
    );
  }
}

function toVectorBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function hasTable(database: Database.Database, tableName: string): boolean {
  const row = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);

  return row !== undefined;
}

function readFtsCount(
  database: Database.Database,
  indexedPath: string,
): number {
  ensureFtsTable(database);
  const row = database
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE c.path = ?
      `,
    )
    .get(indexedPath) as { count: number };
  return row.count;
}

function readTitleFtsCount(
  database: Database.Database,
  indexedPath: string,
): number {
  ensureTitleFtsTable(database);
  const row = database
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM notes_fts
        JOIN notes n ON n.id = notes_fts.rowid
        WHERE n.path = ?
      `,
    )
    .get(indexedPath) as { count: number };
  return row.count;
}

function backfillTitleFtsRow(
  database: Database.Database,
  indexedPath: string,
): void {
  const note = database
    .prepare(
      `
        SELECT id, path, title, aliases_json AS aliasesJson
        FROM notes
        WHERE path = ?
      `,
    )
    .get(indexedPath) as TitleSearchRow | undefined;
  if (note === undefined) {
    return;
  }

  database.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(note.id);
  database
    .prepare(
      `
        INSERT INTO notes_fts (rowid, path, title, aliases)
        VALUES (?, ?, ?, ?)
      `,
    )
    .run(
      note.id,
      note.path,
      note.title,
      parseAliases(note.aliasesJson).join(" "),
    );
}

function backfillFtsRows(
  database: Database.Database,
  indexedPath: string,
): void {
  const chunks = database
    .prepare(
      `
        SELECT id, heading_path AS headingPath, text
        FROM chunks
        WHERE path = ?
        ORDER BY chunk_index
      `,
    )
    .all(indexedPath) as FtsChunkRow[];
  const deleteFts = database.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
  const insertFts = database.prepare(
    `
      INSERT INTO chunks_fts (rowid, path, title, heading_path, text)
      VALUES (?, ?, ?, ?, ?)
    `,
  );

  database.transaction(() => {
    for (const chunk of chunks) {
      deleteFts.run(chunk.id);
      insertFts.run(chunk.id, "", "", chunk.headingPath, chunk.text);
    }
  })();
}

function ensureFtsTable(database: Database.Database): void {
  const row = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'",
    )
    .get();
  if (row === undefined) {
    throw new SearchIndexerError(
      "SQLite FTS5 is not available for BM25 indexing",
    );
  }
}

function ensureTitleFtsTable(database: Database.Database): void {
  const row = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'",
    )
    .get();
  if (row === undefined) {
    throw new SearchIndexerError(
      "SQLite FTS5 is not available for title search indexing",
    );
  }
}

function readTitleSearchCandidateIds(
  database: Database.Database,
  ftsQuery: string,
): number[] {
  return database
    .prepare(
      `
        SELECT rowid AS id
        FROM notes_fts
        WHERE notes_fts MATCH ?
      `,
    )
    .all(ftsQuery)
    .map((row) => (row as { id: number }).id);
}

function parseHeadingPath(headingPath: string | null): string[] {
  if (headingPath === null || headingPath === "") {
    return [];
  }
  return headingPath.split(" / ");
}

function parseAliases(aliasesJson: string | null): string[] {
  if (aliasesJson === null || aliasesJson === "") {
    return [];
  }

  const aliases = JSON.parse(aliasesJson) as unknown;
  if (!Array.isArray(aliases)) {
    return [];
  }

  return aliases.filter((alias): alias is string => typeof alias === "string");
}

function formatSemanticSnippet(text: string): string {
  const compactText = text.replace(/\s+/g, " ").trim();
  if (compactText.length <= 240) {
    return compactText;
  }

  return `${compactText.slice(0, 239)}…`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term !== "")
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" ");
}

function buildRelaxedFtsQuery(query: string): string {
  return query
    .split(/\s+/u)
    .map((term) =>
      term.trim().replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, ""),
    )
    .filter((term) => term.length > 2)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function buildTitleFtsQuery(query: string): string {
  return normalizeSearchText(query)
    .split(/\s+/u)
    .map((term) => term.trim().replace(/[^\p{L}\p{N}_]+/gu, ""))
    .filter((term) => term !== "")
    .map((term) => `${term.replaceAll('"', '""')}*`)
    .join(" ");
}

function normalizeSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 10;
  }

  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

function buildSearchFilterSql(
  noteAlias: string,
  options: SearchFilterOptions,
): { sql: string; params: string[] } {
  const conditions: string[] = [];
  const params: string[] = [];

  if (options.scope !== undefined) {
    const scopePrefix = options.scope.endsWith("/")
      ? options.scope
      : `${options.scope}/`;
    conditions.push(
      `(${noteAlias}.path = ? OR substr(${noteAlias}.path, 1, length(?)) = ?)`,
    );
    params.push(options.scope, scopePrefix, scopePrefix);
  }

  for (const tag of options.tags ?? []) {
    conditions.push(
      `EXISTS (SELECT 1 FROM json_each(${noteAlias}.tags_json) WHERE value = ?)`,
    );
    params.push(tag);
  }

  return {
    sql: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
    params,
  };
}

function readFilteredNoteCount(
  database: Database.Database,
  filters: { sql: string; params: string[] },
): number {
  const row = database
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM notes
        ${filters.sql === "" ? "" : `WHERE ${filters.sql.slice(5)}`}
      `,
    )
    .get(...filters.params) as { count: number };

  return row.count;
}

function scoreTitleMatch(
  query: string,
  title: string,
  aliases: string[],
  notePath: string,
): number {
  const fields = [
    { value: title, exact: 120, contains: 100, token: 80 },
    ...aliases.map((alias) => ({
      value: alias,
      exact: 110,
      contains: 90,
      token: 70,
    })),
    { value: notePath, exact: 100, contains: 75, token: 55 },
  ];
  let bestScore = 0;

  for (const field of fields) {
    const score = scoreFieldMatch(query, field);
    if (score > bestScore) {
      bestScore = score;
    }
  }

  return bestScore;
}

function scoreFieldMatch(
  query: string,
  field: { value: string; exact: number; contains: number; token: number },
): number {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedValue = normalizeSearchText(field.value);
  if (normalizedQuery === "" || normalizedValue === "") {
    return 0;
  }

  if (normalizedValue === normalizedQuery) {
    return field.exact;
  }

  if (normalizedValue.includes(normalizedQuery)) {
    return field.contains;
  }

  const queryTokens = tokenizeSearchText(normalizedQuery);
  const valueTokens = tokenizeSearchText(normalizedValue);
  if (
    queryTokens.length === 0 ||
    !queryTokens.every((queryToken) =>
      valueTokens.some((valueToken) => tokenMatches(queryToken, valueToken)),
    )
  ) {
    return 0;
  }

  return field.token + Math.max(0, 10 - valueTokens.length);
}

function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/\.md$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenizeSearchText(value: string): string[] {
  return value.split(/\s+/u).filter((token) => token !== "");
}

function tokenMatches(queryToken: string, valueToken: string): boolean {
  return (
    valueToken === queryToken ||
    valueToken.startsWith(queryToken) ||
    queryToken.startsWith(valueToken) ||
    (queryToken.length >= 4 && levenshteinDistance(queryToken, valueToken) <= 1)
  );
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex + 1;

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const insertion = previous[rightIndex + 1] + 1;
      const deletion = previous[rightIndex] + 1;
      const substitution =
        diagonal + (left[leftIndex] === right[rightIndex] ? 0 : 1);
      diagonal = previous[rightIndex + 1];
      previous[rightIndex + 1] = Math.min(insertion, deletion, substitution);
    }
  }

  return previous[right.length];
}

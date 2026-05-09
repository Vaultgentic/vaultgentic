import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveVaultRelativePath } from "./config.js";
import {
  chunkMarkdownNote,
  parseMarkdownNote,
  type MarkdownChunk,
  type ParsedMarkdownNote,
} from "./markdown.js";
import { scanVaultFiles, type VaultFileMetadata } from "./scanner.js";
import {
  initializeSearchDatabase,
  schemaVersion,
  type DatabaseStatus,
  type SearchDatabaseConfig,
} from "./database.js";

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

export type RebuildSearchIndexResult = {
  indexed: number;
  skipped: 0;
  deleted: number;
  files: IndexFileResult[];
  status: DatabaseStatus;
};

export type Bm25SearchResult = {
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
  score: number;
  rank: number;
};

type ExistingNoteRow = {
  mtimeMs: number;
  sizeBytes: number;
  contentHash: string;
};

type SearchRow = {
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
};

type FtsChunkRow = {
  id: number;
  path: string;
  title: string;
  headingPath: string | null;
  text: string;
};

type PreparedIndexedFile = {
  metadata: VaultFileMetadata & { content_hash: string };
  note: ParsedMarkdownNote;
  chunks: MarkdownChunk[];
};

export function openSearchDatabase(
  config: SearchDatabaseConfig,
): Database.Database {
  initializeSearchDatabase(config);
  const database = new Database(config.databasePath);
  database.pragma("foreign_keys = ON");
  return database;
}

export async function indexVaultFile(
  config: SearchDatabaseConfig,
  vaultRelativePath: string,
): Promise<IndexFileResult> {
  const relativePath = resolveVaultRelativePath(
    config.vaultPath,
    vaultRelativePath,
  );
  const absolutePath = path.join(config.vaultPath, relativePath);
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
    return indexFileContent(database, metadata, content);
  } finally {
    database.close();
  }
}

export async function syncSearchIndex(
  config: SearchDatabaseConfig,
): Promise<SyncSearchIndexResult> {
  const files = await scanVaultFiles(config, { includeContentHash: true });
  const database = openSearchDatabase(config);

  try {
    const result: SyncSearchIndexResult = {
      indexed: 0,
      skipped: 0,
      deleted: 0,
      files: [],
      deletedPaths: [],
    };
    const currentPaths = new Set(files.map((file) => file.path));

    for (const file of files) {
      if (file.content_hash === undefined) {
        throw new Error(`Missing content hash for scanned file: ${file.path}`);
      }

      const currentResult = indexCurrentFile(database, {
        ...file,
        content_hash: file.content_hash,
      });
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
      const fileResult = indexFileContent(
        database,
        { ...file, content_hash: file.content_hash },
        content,
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
        deleteIndexedPath(database, indexedPath);
        result.deleted += 1;
        result.deletedPaths.push(indexedPath);
      }
    }

    return result;
  } finally {
    database.close();
  }
}

export async function rebuildSearchIndex(
  config: SearchDatabaseConfig,
): Promise<RebuildSearchIndexResult> {
  const files = await scanVaultFiles(config, { includeContentHash: true });
  const preparedFiles: PreparedIndexedFile[] = [];

  for (const file of files) {
    if (file.content_hash === undefined) {
      throw new Error(`Missing content hash for scanned file: ${file.path}`);
    }

    const content = await readFile(
      path.join(config.vaultPath, file.path),
      "utf8",
    );
    preparedFiles.push(
      prepareFileContent({ ...file, content_hash: file.content_hash }, content),
    );
  }

  const database = openSearchDatabase(config);

  try {
    ensureFtsTable(database);
    const currentPaths = new Set(files.map((file) => file.path));
    const deleted = readIndexedPaths(database).filter(
      (indexedPath) => !currentPaths.has(indexedPath),
    ).length;
    const now = Date.now();
    const indexedFiles: IndexFileResult[] = [];

    database.transaction(() => {
      clearIndexedContent(database);

      for (const preparedFile of preparedFiles) {
        writePreparedFile(database, preparedFile, now);
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
      status: readDatabaseStatus(database, config),
    };
  } finally {
    database.close();
  }
}

export function searchBm25(
  config: SearchDatabaseConfig,
  options: { query: string; limit?: number },
): Bm25SearchResult[] {
  const query = options.query.trim();
  if (query === "") {
    return [];
  }

  const database = openSearchDatabase(config);
  try {
    ensureFtsTable(database);
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === "") {
      return [];
    }

    const rows = database
      .prepare(
        `
          SELECT
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
          WHERE chunks_fts MATCH ?
          ORDER BY score ASC
          LIMIT ?
        `,
      )
      .all(ftsQuery, normalizeSearchLimit(options.limit)) as SearchRow[];

    return rows.map((row, index) => ({
      path: row.path,
      title: row.title,
      headingPath: parseHeadingPath(row.headingPath),
      snippet: row.snippet,
      score: row.score,
      rank: index + 1,
      chunkIndex: row.chunkIndex,
      startLine: row.startLine ?? undefined,
      endLine: row.endLine ?? undefined,
    }));
  } finally {
    database.close();
  }
}

export function searchTitles(
  config: SearchDatabaseConfig,
  options: { query: string; limit?: number },
): TitleSearchResult[] {
  const query = options.query.trim();
  if (query === "") {
    return [];
  }

  const database = openSearchDatabase(config);
  try {
    ensureTitleFtsTable(database);
    const ftsQuery = buildTitleFtsQuery(query);
    const candidateIds =
      ftsQuery === "" ? [] : readTitleSearchCandidateIds(database, ftsQuery);
    const rows = database
      .prepare(
        `
          SELECT id, path, title, aliases_json AS aliasesJson
          FROM notes
          ${candidateIds.length > 0 ? `WHERE id IN (${candidateIds.map(() => "?").join(", ")})` : ""}
          ORDER BY path
        `,
      )
      .all(...candidateIds) as TitleSearchRow[];
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
      score: entry.score,
      rank: index + 1,
    }));
  } finally {
    database.close();
  }
}

function indexFileContent(
  database: Database.Database,
  metadata: VaultFileMetadata & { content_hash: string },
  content: string,
): IndexFileResult {
  const existing = readExistingNote(database, metadata.path);

  if (isExistingNoteCurrent(existing, metadata)) {
    const currentResult = indexCurrentFile(database, metadata);
    if (currentResult !== undefined) {
      return currentResult;
    }
  }

  ensureFtsTable(database);
  const preparedFile = prepareFileContent(metadata, content);
  const now = Date.now();

  database.transaction(() => {
    deleteIndexedPath(database, metadata.path);
    writePreparedFile(database, preparedFile, now);
  })();

  return {
    path: metadata.path,
    status: "indexed",
    chunkCount: preparedFile.chunks.length,
  };
}

function prepareFileContent(
  metadata: VaultFileMetadata & { content_hash: string },
  content: string,
): PreparedIndexedFile {
  const note = parseMarkdownNote({ path: metadata.path, content });
  return {
    metadata,
    note,
    chunks: chunkMarkdownNote(note),
  };
}

function writePreparedFile(
  database: Database.Database,
  preparedFile: PreparedIndexedFile,
  now: number,
): void {
  const { metadata, note, chunks } = preparedFile;
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

  for (const chunk of chunks) {
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
      chunk.path,
      chunk.title,
      headingPath,
      chunk.text,
    );
  }
}

function indexCurrentFile(
  database: Database.Database,
  metadata: VaultFileMetadata & { content_hash: string },
): IndexFileResult | undefined {
  const existing = readExistingNote(database, metadata.path);
  if (!isExistingNoteCurrent(existing, metadata)) {
    return undefined;
  }

  const chunkCount = readChunkCount(database, metadata.path);
  if (
    readFtsCount(database, metadata.path) === chunkCount &&
    readTitleFtsCount(database, metadata.path) === 1
  ) {
    return { path: metadata.path, status: "skipped", chunkCount };
  }

  ensureFtsTable(database);
  ensureTitleFtsTable(database);
  backfillTitleFtsRow(database, metadata.path);
  backfillFtsRows(database, metadata.path);
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
): void {
  const noteIds = database
    .prepare("SELECT id FROM notes WHERE path = ?")
    .all(indexedPath) as Array<{ id: number }>;
  const chunkIds = database
    .prepare("SELECT id FROM chunks WHERE path = ?")
    .all(indexedPath) as Array<{ id: number }>;
  const deleteNoteFts = database.prepare(
    "DELETE FROM notes_fts WHERE rowid = ?",
  );
  const deleteFts = database.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
  for (const note of noteIds) {
    deleteNoteFts.run(note.id);
  }
  for (const chunk of chunkIds) {
    deleteFts.run(chunk.id);
  }
  database.prepare("DELETE FROM notes WHERE path = ?").run(indexedPath);
}

function clearIndexedContent(database: Database.Database): void {
  database.prepare("DELETE FROM notes_fts").run();
  database.prepare("DELETE FROM chunks_fts").run();
  database.prepare("DELETE FROM chunks").run();
  database.prepare("DELETE FROM notes").run();
}

function readDatabaseStatus(
  database: Database.Database,
  config: SearchDatabaseConfig,
): DatabaseStatus {
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
      sqliteVecAvailable: isSqliteVecAvailable(database),
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
        SELECT id, path, title, heading_path AS headingPath, text
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
      insertFts.run(
        chunk.id,
        chunk.path,
        chunk.title,
        chunk.headingPath,
        chunk.text,
      );
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
    throw new Error("SQLite FTS5 is not available for BM25 indexing");
  }
}

function ensureTitleFtsTable(database: Database.Database): void {
  const row = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'",
    )
    .get();
  if (row === undefined) {
    throw new Error("SQLite FTS5 is not available for title search indexing");
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

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveVaultRelativePath } from "./config.js";
import { chunkMarkdownNote, parseMarkdownNote } from "./markdown.js";
import { scanVaultFiles, type VaultFileMetadata } from "./scanner.js";
import {
  initializeSearchDatabase,
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
  const note = parseMarkdownNote({ path: metadata.path, content });
  const chunks = chunkMarkdownNote(note);
  const now = Date.now();

  database.transaction(() => {
    deleteIndexedPath(database, metadata.path);

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
    const insertFts = database.prepare(
      `
        INSERT INTO chunks_fts (rowid, path, title, heading_path, text)
        VALUES (?, ?, ?, ?, ?)
      `,
    );

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
  })();

  return { path: metadata.path, status: "indexed", chunkCount: chunks.length };
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
  if (readFtsCount(database, metadata.path) === chunkCount) {
    return { path: metadata.path, status: "skipped", chunkCount };
  }

  ensureFtsTable(database);
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
  const chunkIds = database
    .prepare("SELECT id FROM chunks WHERE path = ?")
    .all(indexedPath) as Array<{ id: number }>;
  const deleteFts = database.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
  for (const chunk of chunkIds) {
    deleteFts.run(chunk.id);
  }
  database.prepare("DELETE FROM notes WHERE path = ?").run(indexedPath);
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

function parseHeadingPath(headingPath: string | null): string[] {
  if (headingPath === null || headingPath === "") {
    return [];
  }
  return headingPath.split(" / ");
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

function normalizeSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 10;
  }

  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

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

type FtsChunkRow = {
  id: number;
  path: string;
  title: string;
  headingPath: string | null;
  text: string;
};

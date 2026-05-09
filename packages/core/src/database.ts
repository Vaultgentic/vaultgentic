import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import * as sqliteVec from "sqlite-vec";
import { embeddingModelMetadata } from "./embedding.js";
import { VaultgenticError } from "./errors.js";

export const schemaVersion = 1;
export const chunkerVersion = "2";

export class SearchDatabaseError extends VaultgenticError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SearchDatabaseError";
  }
}

export type SearchDatabaseConfig = {
  vaultPath: string;
  databasePath: string;
  ignoredPaths?: string[];
};

export type DatabaseStatus = {
  vaultPath: string;
  databasePath: string;
  schemaVersion: number;
  noteCount: number;
  chunkCount: number;
  lastIndexedAt: number | null;
  sqlite: {
    ok: boolean;
    walEnabled: boolean;
    foreignKeysEnabled: boolean;
    fts5Available: boolean;
    sqliteVecAvailable: boolean;
  };
  vectors: {
    ready: boolean;
    chunkEmbeddingCount: number;
    modelId: string;
    dimension: number;
    normalized: boolean;
    chunkerVersion: string;
  };
};

type InitializeSearchDatabaseOptions = {
  skipEmbeddingMetadataValidation?: boolean;
};

export function initializeSearchDatabase(
  config: SearchDatabaseConfig,
  options: InitializeSearchDatabaseOptions = {},
): DatabaseStatus {
  let database: Database.Database | undefined;

  try {
    const databaseExists = existsSync(config.databasePath);
    mkdirSync(path.dirname(config.databasePath), { recursive: true });

    database = new Database(config.databasePath);
    const activeDatabase = database;

    if (databaseExists) {
      validateExistingDatabase(activeDatabase, config);
    }

    const sqliteVecAvailable = loadSqliteVec(activeDatabase);

    activeDatabase.pragma("journal_mode = WAL");
    activeDatabase.pragma("synchronous = NORMAL");
    activeDatabase.pragma("foreign_keys = ON");

    activeDatabase.transaction(() => {
      activeDatabase.exec(`
        CREATE TABLE IF NOT EXISTS index_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          aliases_json TEXT,
          tags_json TEXT,
          frontmatter_json TEXT,
          links_json TEXT,
          mtime_ms INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          indexed_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chunks (
          id INTEGER PRIMARY KEY,
          note_id INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL,
          path TEXT NOT NULL,
          title TEXT NOT NULL,
          heading_path TEXT,
          block_id TEXT,
          start_line INTEGER,
          end_line INTEGER,
          text TEXT NOT NULL,
          token_estimate INTEGER,
          content_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_note_id ON chunks(note_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      `);

      if (isFts5Available(activeDatabase)) {
        activeDatabase.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            path,
            title,
            aliases
          );

          CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            path,
            title,
            heading_path,
            text
          );
        `);
      }

      if (sqliteVecAvailable) {
        createChunkEmbeddingTable(activeDatabase);
      }

      const insertMetadata = activeDatabase.prepare(
        "INSERT OR IGNORE INTO index_metadata (key, value) VALUES (?, ?)",
      );
      insertMetadata.run("schema_version", String(schemaVersion));
      insertMetadata.run("vault_root", config.vaultPath);
      insertMetadata.run("embedding_model_id", embeddingModelMetadata.modelId);
      insertMetadata.run(
        "embedding_dimension",
        String(embeddingModelMetadata.dimension),
      );
      insertMetadata.run(
        "embedding_normalized",
        String(embeddingModelMetadata.normalized),
      );
      insertMetadata.run("chunker_version", chunkerVersion);
    })();

    const storedSchemaVersion = Number(
      readMetadata(activeDatabase, "schema_version"),
    );
    if (storedSchemaVersion !== schemaVersion) {
      throw new SearchDatabaseError(
        `Unsupported database schema version ${storedSchemaVersion}; expected ${schemaVersion}`,
      );
    }

    const storedVaultPath = readMetadata(activeDatabase, "vault_root");
    if (storedVaultPath !== config.vaultPath) {
      throw new SearchDatabaseError(
        `Database vault root mismatch: ${storedVaultPath} does not match ${config.vaultPath}`,
      );
    }

    if (options.skipEmbeddingMetadataValidation !== true) {
      validateEmbeddingMetadata(activeDatabase);
    }

    return {
      vaultPath: config.vaultPath,
      databasePath: config.databasePath,
      schemaVersion: storedSchemaVersion,
      noteCount: readCount(activeDatabase, "notes"),
      chunkCount: readCount(activeDatabase, "chunks"),
      lastIndexedAt: readLastIndexedAt(activeDatabase),
      sqlite: {
        ok: true,
        walEnabled: readJournalMode(activeDatabase) === "wal",
        foreignKeysEnabled: readForeignKeys(activeDatabase),
        fts5Available: isFts5Available(activeDatabase),
        sqliteVecAvailable,
      },
      vectors: {
        ready:
          sqliteVecAvailable && hasTable(activeDatabase, "chunk_embeddings"),
        chunkEmbeddingCount: sqliteVecAvailable
          ? readVectorCount(activeDatabase)
          : 0,
        modelId: embeddingModelMetadata.modelId,
        dimension: embeddingModelMetadata.dimension,
        normalized: embeddingModelMetadata.normalized,
        chunkerVersion,
      },
    };
  } catch (error) {
    throw toSearchDatabaseError("Failed to initialize search database", error);
  } finally {
    database?.close();
  }
}

export function resetEmbeddingStorage(database: Database.Database): void {
  if (!isSqliteVecAvailable(database)) {
    throw new SearchDatabaseError(
      "sqlite-vec is not available for chunk embedding storage",
    );
  }

  database.exec("DROP TABLE IF EXISTS chunk_embeddings");
  createChunkEmbeddingTable(database);
  writeEmbeddingMetadata(database);
}

export function loadSqliteVec(database: Database.Database): boolean {
  try {
    sqliteVec.load(database);
    database.prepare("SELECT vec_version() AS version").get();
    return true;
  } catch {
    return false;
  }
}

function toSearchDatabaseError(
  message: string,
  error: unknown,
): SearchDatabaseError {
  if (error instanceof SearchDatabaseError) {
    return error;
  }

  if (error instanceof Error) {
    return new SearchDatabaseError(`${message}: ${error.message}`, {
      cause: error,
    });
  }

  return new SearchDatabaseError(`${message}: ${String(error)}`, {
    cause: error,
  });
}

function validateExistingDatabase(
  database: Database.Database,
  config: SearchDatabaseConfig,
): void {
  if (!hasTable(database, "index_metadata")) {
    throw new SearchDatabaseError(
      `Existing database is missing Vaultgentic metadata: ${config.databasePath}`,
    );
  }

  const storedSchemaVersion = Number(readMetadata(database, "schema_version"));
  if (storedSchemaVersion !== schemaVersion) {
    throw new SearchDatabaseError(
      `Unsupported database schema version ${storedSchemaVersion}; expected ${schemaVersion}`,
    );
  }

  const storedVaultPath = readMetadata(database, "vault_root");
  if (storedVaultPath !== config.vaultPath) {
    throw new SearchDatabaseError(
      `Database vault root mismatch: ${storedVaultPath} does not match ${config.vaultPath}`,
    );
  }
}

function writeEmbeddingMetadata(database: Database.Database): void {
  const updateMetadata = database.prepare(
    "UPDATE index_metadata SET value = ? WHERE key = ?",
  );
  updateMetadata.run(embeddingModelMetadata.modelId, "embedding_model_id");
  updateMetadata.run(
    String(embeddingModelMetadata.dimension),
    "embedding_dimension",
  );
  updateMetadata.run(
    String(embeddingModelMetadata.normalized),
    "embedding_normalized",
  );
  updateMetadata.run(chunkerVersion, "chunker_version");
}

function createChunkEmbeddingTable(database: Database.Database): void {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
      embedding float[${embeddingModelMetadata.dimension}]
    );
  `);
}

function validateEmbeddingMetadata(database: Database.Database): void {
  const expectedMetadata = {
    embedding_model_id: embeddingModelMetadata.modelId,
    embedding_dimension: String(embeddingModelMetadata.dimension),
    embedding_normalized: String(embeddingModelMetadata.normalized),
    chunker_version: chunkerVersion,
  };

  for (const [key, expectedValue] of Object.entries(expectedMetadata)) {
    const value = readMetadata(database, key);
    if (value !== expectedValue) {
      throw new SearchDatabaseError(
        `Embedding metadata mismatch for ${key}: ${value} does not match ${expectedValue}; full reindex required`,
      );
    }
  }
}

function hasTable(database: Database.Database, tableName: string): boolean {
  const row = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { 1: number } | undefined;

  return row !== undefined;
}

function readMetadata(database: Database.Database, key: string): string {
  const row = database
    .prepare("SELECT value FROM index_metadata WHERE key = ?")
    .get(key) as { value: string } | undefined;

  if (row === undefined) {
    throw new SearchDatabaseError(`Missing index metadata: ${key}`);
  }

  return row.value;
}

function readCount(database: Database.Database, tableName: "notes" | "chunks") {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get() as {
    count: number;
  };

  return row.count;
}

function readVectorCount(database: Database.Database): number {
  if (!hasTable(database, "chunk_embeddings")) {
    return 0;
  }

  const row = database
    .prepare("SELECT COUNT(*) AS count FROM chunk_embeddings")
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

function hasCompileOption(
  database: Database.Database,
  option: string,
): boolean {
  return (
    database.pragma("compile_options") as Array<{ compile_options: string }>
  ).some((row) => row.compile_options === option);
}

function isFts5Available(database: Database.Database): boolean {
  if (hasCompileOption(database, "ENABLE_FTS5")) {
    return true;
  }

  try {
    database.prepare("SELECT fts5(?) AS value").get("check");
    return true;
  } catch {
    return false;
  }
}

function isSqliteVecAvailable(database: Database.Database): boolean {
  try {
    database.prepare("SELECT vec_version() AS version").get();
    return true;
  } catch {
    return false;
  }
}

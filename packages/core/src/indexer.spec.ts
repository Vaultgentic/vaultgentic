import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initializeSearchDatabase, loadSqliteVec } from "./database.js";
import {
  indexVaultFile,
  rebuildSearchIndex,
  searchBm25,
  SearchIndexerError,
  searchSemantic,
  searchTitles,
  syncSearchIndex,
} from "./indexer.js";

vi.mock("./embedding.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./embedding.js")>();

  return {
    ...original,
    embedChunkText: vi.fn(async (text: string) => ({
      vector: Array.from(
        { length: original.embeddingModelMetadata.dimension },
        () => text.length / 100,
      ),
      metadata: original.embeddingModelMetadata,
    })),
    embedQueryText: vi.fn(async (text: string) => ({
      vector: Array.from(
        { length: original.embeddingModelMetadata.dimension },
        () => text.length / 100,
      ),
      metadata: original.embeddingModelMetadata,
    })),
  };
});

describe("GIVEN a BM25 search index", () => {
  describe("WHEN a single markdown file is indexed", () => {
    describe("THEN note chunks and FTS rows are populated", () => {
      it("SHOULD index searchable note content", async () => {
        const config = await createFixture("single-file");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "# Alpha\n\nImportant keyword zebra lives here.",
        );

        const result = await indexVaultFile(config, "alpha.md");

        expect(result).toMatchObject({
          path: "alpha.md",
          status: "indexed",
          chunkCount: 1,
        });
        expect(readCounts(config.databasePath)).toEqual({
          notes: 1,
          chunks: 1,
          fts: 1,
          vectors: 1,
        });
      });
    });
  });

  describe("WHEN an index path escapes the vault", () => {
    describe("THEN path traversal is rejected by the indexer", () => {
      it("SHOULD use the localized indexer error type", async () => {
        const config = await createFixture("indexer-path-traversal");

        await expect(
          indexVaultFile(config, "../escape.md"),
        ).rejects.toBeInstanceOf(SearchIndexerError);
      });
    });
  });

  describe("WHEN an indexed file does not exist", () => {
    describe("THEN filesystem failures are localized", () => {
      it("SHOULD use the indexer error type", async () => {
        const config = await createFixture("missing-index-file");

        await expect(
          indexVaultFile(config, "missing.md"),
        ).rejects.toBeInstanceOf(SearchIndexerError);
      });
    });
  });

  describe("WHEN an unchanged file is indexed again", () => {
    describe("THEN duplicate indexing work is skipped", () => {
      it("SHOULD return skipped with the existing chunk count", async () => {
        const config = await createFixture("skip-file");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "# Alpha\n\nSame text",
        );
        await indexVaultFile(config, "alpha.md");

        const result = await indexVaultFile(config, "alpha.md");

        expect(result).toEqual({
          path: "alpha.md",
          status: "skipped",
          chunkCount: 1,
        });
        expect(readCounts(config.databasePath)).toEqual({
          notes: 1,
          chunks: 1,
          fts: 1,
          vectors: 1,
        });
      });
    });
  });

  describe("WHEN an unchanged file is missing FTS rows", () => {
    describe("THEN the keyword index is backfilled", () => {
      it("SHOULD restore BM25 visibility without duplicating chunks", async () => {
        const config = await createFixture("backfill-file");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "# Alpha\n\nThe backfill keyword appears here.",
        );
        await indexVaultFile(config, "alpha.md");
        deleteFtsRows(config.databasePath);

        const result = await indexVaultFile(config, "alpha.md");

        expect(result).toEqual({
          path: "alpha.md",
          status: "indexed",
          chunkCount: 1,
        });
        expect(searchBm25(config, { query: "backfill" })).toHaveLength(1);
        expect(readCounts(config.databasePath)).toEqual({
          notes: 1,
          chunks: 1,
          fts: 1,
          vectors: 1,
        });
      });
    });
  });

  describe("WHEN an indexed file changes", () => {
    describe("THEN old FTS and vector rows are replaced", () => {
      it("SHOULD remove stale searchable terms and embeddings", async () => {
        const config = await createFixture("reindex-file");
        const filePath = path.join(config.vaultPath, "alpha.md");
        await writeFile(filePath, "# Alpha\n\nThe oldterm is here.");
        await indexVaultFile(config, "alpha.md");
        await writeFile(filePath, "# Alpha\n\nThe newterm is here.");

        await indexVaultFile(config, "alpha.md");

        expect(searchBm25(config, { query: "oldterm" })).toEqual([]);
        expect(searchBm25(config, { query: "newterm" })).toHaveLength(1);
        expect(readCounts(config.databasePath)).toMatchObject({
          notes: 1,
          chunks: 1,
          vectors: 1,
        });
      });
    });
  });

  describe("WHEN the vault is synced after deletion", () => {
    describe("THEN missing files are removed from the index", () => {
      it("SHOULD delete note chunks, FTS rows, and vector rows", async () => {
        const config = await createFixture("delete-file");
        const filePath = path.join(config.vaultPath, "alpha.md");
        await writeFile(filePath, "# Alpha\n\nDelete me keyword.");
        await indexVaultFile(config, "alpha.md");
        await rm(filePath);

        const result = await syncSearchIndex(config);

        expect(result.deletedPaths).toEqual(["alpha.md"]);
        expect(readCounts(config.databasePath)).toEqual({
          notes: 0,
          chunks: 0,
          fts: 0,
          vectors: 0,
        });
      });
    });
  });

  describe("WHEN the index is rebuilt from scratch", () => {
    describe("THEN stale local data is replaced", () => {
      it("SHOULD clear deleted notes and index current vault files", async () => {
        const config = await createFixture("rebuild-stale-file");
        const stalePath = path.join(config.vaultPath, "stale.md");
        await writeFile(stalePath, "# Stale\n\noldterm");
        await indexVaultFile(config, "stale.md");
        await rm(stalePath);
        await writeFile(
          path.join(config.vaultPath, "current.md"),
          "# Current\n\nnewterm",
        );

        const result = await rebuildSearchIndex(config);

        expect(result).toMatchObject({
          indexed: 1,
          skipped: 0,
          deleted: 1,
          status: {
            noteCount: 1,
            chunkCount: 1,
            lastIndexedAt: expect.any(Number),
          },
        });
        expect(result.files).toEqual([
          { path: "current.md", status: "indexed", chunkCount: 1 },
        ]);
        expect(searchBm25(config, { query: "oldterm" })).toEqual([]);
        expect(searchBm25(config, { query: "newterm" })).toHaveLength(1);
        expect(readCounts(config.databasePath)).toEqual({
          notes: 1,
          chunks: 1,
          fts: 1,
          vectors: 1,
        });
      });
    });
  });

  describe("WHEN the index is rebuilt with multiple markdown files", () => {
    describe("THEN every current note is parsed, chunked, and indexed", () => {
      it("SHOULD rebuild searchable chunks for all scanned notes", async () => {
        const config = await createFixture("rebuild-multiple-files");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "# Alpha\n\nkeyword-one",
        );
        await writeFile(
          path.join(config.vaultPath, "beta.md"),
          "# Beta\n\nkeyword-two",
        );

        const result = await rebuildSearchIndex(config);

        expect(result.indexed).toBe(2);
        expect(result.deleted).toBe(0);
        expect(result.status.noteCount).toBe(2);
        expect(result.status.chunkCount).toBe(2);
        expect(searchBm25(config, { query: "keyword-one" })).toHaveLength(1);
        expect(searchBm25(config, { query: "keyword-two" })).toHaveLength(1);
      });
    });
  });

  describe("WHEN the index is rebuilt after embedding metadata changes", () => {
    describe("THEN stale vector storage is recreated", () => {
      it("SHOULD replace the old vector table before writing embeddings", async () => {
        const config = await createFixture("rebuild-stale-vector-table");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "# Alpha\n\nThe rebuilt vector should fit the current model.",
        );
        createStaleVectorTable(config.databasePath);

        const result = await rebuildSearchIndex(config);

        expect(result.status.vectors).toMatchObject({
          ready: true,
          chunkEmbeddingCount: 1,
          dimension: 384,
        });
        expect(readCounts(config.databasePath).vectors).toBe(1);
      });
    });
  });

  describe("WHEN an unchanged file is missing vector rows", () => {
    describe("THEN the embedding index is backfilled", () => {
      it("SHOULD restore vector storage without duplicating chunks", async () => {
        const config = await createFixture("backfill-vectors");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "# Alpha\n\nThe semantic vector should be restored.",
        );
        await indexVaultFile(config, "alpha.md");
        deleteVectorRows(config.databasePath);

        const result = await indexVaultFile(config, "alpha.md");

        expect(result).toEqual({
          path: "alpha.md",
          status: "indexed",
          chunkCount: 1,
        });
        expect(readCounts(config.databasePath)).toEqual({
          notes: 1,
          chunks: 1,
          fts: 1,
          vectors: 1,
        });
      });
    });
  });

  describe("WHEN BM25 search is queried", () => {
    describe("THEN ranked candidates are returned", () => {
      it("SHOULD return exact keyword matches with snippets", async () => {
        const config = await createFixture("search-file");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "# Alpha\n\nneedle needle needle appears here.",
        );
        await writeFile(
          path.join(config.vaultPath, "beta.md"),
          "# Beta\n\nneedle appears once.",
        );
        await syncSearchIndex(config);

        const results = searchBm25(config, { query: "needle", limit: 5 });

        expect(results.map((result) => result.rank)).toEqual([1, 2]);
        expect(results.map((result) => result.path).sort()).toEqual([
          "alpha.md",
          "beta.md",
        ]);
        expect(results[0]?.snippet).toContain("needle");
        expect(results[0]?.score).toEqual(expect.any(Number));
      });
    });
  });

  describe("WHEN BM25 search contains punctuation", () => {
    describe("THEN the query is treated as safe keyword text", () => {
      it("SHOULD not throw FTS syntax errors", async () => {
        const config = await createFixture("punctuation-search");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "# Alpha\n\nThe foo-bar token is searchable.",
        );
        await syncSearchIndex(config);

        expect(() => searchBm25(config, { query: "foo-bar" })).not.toThrow();
      });
    });
  });

  describe("WHEN BM25 search receives an invalid limit", () => {
    describe("THEN the limit is kept bounded", () => {
      it("SHOULD not treat negative limits as unlimited", async () => {
        const config = await createFixture("negative-limit-search");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "# Alpha\n\nneedle",
        );
        await writeFile(
          path.join(config.vaultPath, "beta.md"),
          "# Beta\n\nneedle",
        );
        await syncSearchIndex(config);

        expect(searchBm25(config, { query: "needle", limit: -1 })).toHaveLength(
          1,
        );
      });
    });
  });

  describe("WHEN semantic search is queried", () => {
    describe("THEN nearest vector chunks are returned", () => {
      it("SHOULD return ranked semantic matches with chunk metadata", async () => {
        const config = await createFixture("semantic-search");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "# Alpha\n\nshort idea",
        );
        await writeFile(
          path.join(config.vaultPath, "beta.md"),
          "# Beta\n\nThis note contains a much longer unrelated paragraph for distance.",
        );
        await syncSearchIndex(config);

        const results = await searchSemantic(config, {
          query: "short idea",
          limit: 1,
        });

        expect(results).toMatchObject([
          {
            rank: 1,
            path: "alpha.md",
            title: "alpha",
            headingPath: ["Alpha"],
            snippet: expect.stringContaining("short idea"),
            score: expect.any(Number),
            chunkIndex: expect.any(Number),
          },
        ]);
      });
    });
  });

  describe("WHEN semantic search sees stale embedding metadata", () => {
    describe("THEN a clear indexer error is raised", () => {
      it("SHOULD explain that a full reindex is required", async () => {
        const config = await createFixture("semantic-stale-metadata");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "# Alpha\n\nshort idea",
        );
        await syncSearchIndex(config);
        createStaleVectorTable(config.databasePath);

        await expect(
          searchSemantic(config, { query: "short idea" }),
        ).rejects.toThrow(/full reindex required/);
      });
    });
  });

  describe("WHEN title search is queried", () => {
    describe("THEN known notes are matched by title, alias, and path", () => {
      it("SHOULD return exact title matches first", async () => {
        const config = await createFixture("title-search-title");
        await writeTitleSearchFiles(config.vaultPath);
        await syncSearchIndex(config);

        const results = searchTitles(config, {
          query: "Embedding Index",
          limit: 5,
        });

        expect(results[0]).toMatchObject({
          rank: 1,
          title: "Embedding Index",
          path: "search/embedding-index.md",
          aliases: ["Vector Lookup"],
          score: expect.any(Number),
        });
      });

      it("SHOULD return alias matches", async () => {
        const config = await createFixture("title-search-alias");
        await writeTitleSearchFiles(config.vaultPath);
        await syncSearchIndex(config);

        const results = searchTitles(config, { query: "Vector Lookup" });

        expect(results[0]?.path).toBe("search/embedding-index.md");
      });

      it("SHOULD return path matches", async () => {
        const config = await createFixture("title-search-path");
        await writeTitleSearchFiles(config.vaultPath);
        await syncSearchIndex(config);

        const results = searchTitles(config, { query: "daily planning" });

        expect(results[0]).toMatchObject({
          title: "Daily Plan",
          path: "journals/daily-planning.md",
        });
      });

      it("SHOULD return partial and typo-tolerant matches", async () => {
        const config = await createFixture("title-search-typo");
        await writeTitleSearchFiles(config.vaultPath);
        await syncSearchIndex(config);

        const partialResults = searchTitles(config, { query: "embed index" });
        const typoResults = searchTitles(config, { query: "embeding index" });

        expect(partialResults[0]?.path).toBe("search/embedding-index.md");
        expect(typoResults[0]?.path).toBe("search/embedding-index.md");
      });

      it("SHOULD return no results for unknown notes", async () => {
        const config = await createFixture("title-search-empty");
        await writeTitleSearchFiles(config.vaultPath);
        await syncSearchIndex(config);

        const results = searchTitles(config, { query: "missing notebook" });

        expect(results).toEqual([]);
      });
    });
  });

  describe("WHEN the indexer raises its own errors", () => {
    describe("THEN they use a localized error type", () => {
      it("SHOULD expose a service-specific error class", () => {
        expect(new SearchIndexerError("index failed")).toBeInstanceOf(Error);
      });
    });
  });
});

async function createFixture(name: string): Promise<{
  vaultPath: string;
  databasePath: string;
}> {
  const cwd = await mkdtemp(
    path.join(tmpdir(), `vaultgentic-indexer-${name}-`),
  );
  const vaultPath = path.join(cwd, "vault");
  const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
  await mkdir(vaultPath, { recursive: true });

  const config = { vaultPath, databasePath };
  initializeSearchDatabase(config);
  return config;
}

async function writeTitleSearchFiles(vaultPath: string): Promise<void> {
  await mkdir(path.join(vaultPath, "search"), { recursive: true });
  await mkdir(path.join(vaultPath, "journals"), { recursive: true });
  await writeFile(
    path.join(vaultPath, "search", "embedding-index.md"),
    "---\ntitle: Embedding Index\naliases:\n  - Vector Lookup\n---\n\n# Embedding Index\n\nSemantic notes.",
  );
  await writeFile(
    path.join(vaultPath, "journals", "daily-planning.md"),
    "---\ntitle: Daily Plan\n---\n\n# Daily Plan\n\nTasks.",
  );
}

function readCounts(databasePath: string): {
  notes: number;
  chunks: number;
  fts: number;
  vectors: number;
} {
  const database = new Database(databasePath, { readonly: true });
  try {
    loadSqliteVec(database);
    return {
      notes: readCount(database, "notes"),
      chunks: readCount(database, "chunks"),
      fts: readCount(database, "chunks_fts"),
      vectors: readCount(database, "chunk_embeddings"),
    };
  } finally {
    database.close();
  }
}

function readCount(database: Database.Database, tableName: string): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get() as { count: number };
  return row.count;
}

function deleteFtsRows(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.prepare("DELETE FROM chunks_fts").run();
  } finally {
    database.close();
  }
}

function deleteVectorRows(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    loadSqliteVec(database);
    database.prepare("DELETE FROM chunk_embeddings").run();
  } finally {
    database.close();
  }
}

function createStaleVectorTable(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    loadSqliteVec(database);
    database.exec(`
      DROP TABLE chunk_embeddings;
      CREATE VIRTUAL TABLE chunk_embeddings USING vec0(embedding float[4]);
    `);
    database
      .prepare("UPDATE index_metadata SET value = ? WHERE key = ?")
      .run("4", "embedding_dimension");
  } finally {
    database.close();
  }
}

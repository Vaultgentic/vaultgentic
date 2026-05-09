import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeSearchDatabase } from "./database.js";
import {
  indexVaultFile,
  rebuildSearchIndex,
  searchBm25,
  searchTitles,
  syncSearchIndex,
} from "./indexer.js";

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
        });
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
        });
      });
    });
  });

  describe("WHEN an indexed file changes", () => {
    describe("THEN old FTS rows are replaced", () => {
      it("SHOULD remove stale searchable terms", async () => {
        const config = await createFixture("reindex-file");
        const filePath = path.join(config.vaultPath, "alpha.md");
        await writeFile(filePath, "# Alpha\n\nThe oldterm is here.");
        await indexVaultFile(config, "alpha.md");
        await writeFile(filePath, "# Alpha\n\nThe newterm is here.");

        await indexVaultFile(config, "alpha.md");

        expect(searchBm25(config, { query: "oldterm" })).toEqual([]);
        expect(searchBm25(config, { query: "newterm" })).toHaveLength(1);
      });
    });
  });

  describe("WHEN the vault is synced after deletion", () => {
    describe("THEN missing files are removed from the index", () => {
      it("SHOULD delete note chunks and FTS rows", async () => {
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
} {
  const database = new Database(databasePath, { readonly: true });
  try {
    return {
      notes: readCount(database, "notes"),
      chunks: readCount(database, "chunks"),
      fts: readCount(database, "chunks_fts"),
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

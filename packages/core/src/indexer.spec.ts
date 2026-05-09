import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initializeSearchDatabase } from "./database.js";
import { indexVaultFile, searchBm25, syncSearchIndex } from "./indexer.js";

describe("GIVEN a BM25 search index", () => {
  describe("WHEN a single markdown file is indexed", () => {
    describe("THEN note chunks and FTS rows are populated", () => {
      test("SHOULD index searchable note content", async () => {
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
      test("SHOULD return skipped with the existing chunk count", async () => {
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
      test("SHOULD restore BM25 visibility without duplicating chunks", async () => {
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
      test("SHOULD remove stale searchable terms", async () => {
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
      test("SHOULD delete note chunks and FTS rows", async () => {
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

  describe("WHEN BM25 search is queried", () => {
    describe("THEN ranked candidates are returned", () => {
      test("SHOULD return exact keyword matches with snippets", async () => {
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
      test("SHOULD not throw FTS syntax errors", async () => {
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
      test("SHOULD not treat negative limits as unlimited", async () => {
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

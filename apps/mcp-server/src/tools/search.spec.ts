import type { RefreshSearchIndexResult, SearchOutput } from "@vaultgentic/core";
import { describe, expect, it } from "vitest";
import { createSearchToolHandler, searchToolInputSchema } from "./search.js";
import { toMcpToolError } from "./shared.js";

describe("GIVEN the MCP search tool", () => {
  describe("WHEN searching the vault", () => {
    describe("THEN inputs and outputs are shaped for MCP callers", () => {
      it("SHOULD default to hybrid search and hide scores", async () => {
        const searched: unknown[] = [];
        const search = createSearchToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          ensureIndexFresh: async () => createRefreshResult(1),
          search: async (_config, options) => {
            searched.push(options);
            return [createSearchResult(0.5)];
          },
        });

        const response = await search({ query: "alpha" });

        expect(searched).toEqual([{ query: "alpha", mode: "hybrid" }]);
        expect(response.results[0]).toMatchObject({
          rank: 1,
          path: "alpha.md",
          chunkId: 7,
        });
        expect(response.results[0]).not.toHaveProperty("score");
      });

      it("SHOULD include scores when requested", async () => {
        const search = createSearchToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          ensureIndexFresh: async () => createRefreshResult(1),
          search: async () => [createSearchResult(-0.5)],
        });

        const response = await search({ query: "alpha", includeScores: true });

        expect(response.results[0]).toMatchObject({ score: 0.5 });
        expect(response.scoreMetadata).toMatchObject({
          kind: "relevance",
          higherIsBetter: true,
        });
      });

      it("SHOULD normalize hybrid component scores when requested", async () => {
        const search = createSearchToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          ensureIndexFresh: async () => createRefreshResult(1),
          search: async () => [createHybridSearchResult()],
        });

        const response = await search({ query: "alpha", includeScores: true });

        expect(response.results[0]).toMatchObject({
          score: 0.032,
          componentScores: {
            keyword: { rank: 1, score: 12 },
            vector: { rank: 2, score: 0.8 },
            title: { rank: 3, score: 4 },
          },
        });
      });

      it("SHOULD normalize semantic distance scores when requested", async () => {
        const search = createSearchToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          ensureIndexFresh: async () => createRefreshResult(1),
          search: async () => [createSemanticSearchResult()],
        });

        const response = await search({
          query: "alpha",
          mode: "semantic",
          includeScores: true,
        });

        expect(response.results[0]).toMatchObject({ score: 0.8 });
        expect(response.scoreMetadata).toMatchObject({
          kind: "relevance",
          higherIsBetter: true,
        });
      });

      it("SHOULD reject oversized search inputs", () => {
        expect(
          searchToolInputSchema.safeParse({ query: "x".repeat(1_001) }).success,
        ).toBe(false);
      });

      it("SHOULD throw structured safe errors", async () => {
        const search = createSearchToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          ensureIndexFresh: async () => createRefreshResult(1),
          search: async () => {
            throw new Error("SQLite FTS5 is not available for BM25 indexing");
          },
        });

        await expect(search({ query: "alpha" })).rejects.toMatchObject({
          name: "VaultgenticMcpToolError",
          code: "fts_unavailable",
          details: {
            name: "Error",
            message: "SQLite FTS5 is not available for BM25 indexing",
            code: "fts_unavailable",
            expected: false,
          },
        });
      });

      it("SHOULD classify invalid tool input errors", async () => {
        const search = createSearchToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          ensureIndexFresh: async () => createRefreshResult(1),
          search: async () => [],
        });

        await expect(search({ query: "" })).rejects.toMatchObject({
          code: "invalid_tool_input",
          expected: true,
        });
      });
    });
  });
});

describe("GIVEN MCP tool error shaping", () => {
  describe("WHEN mapping expected core errors", () => {
    describe("THEN callers receive structured details", () => {
      it("SHOULD preserve expected flags without stack traces", () => {
        const error = Object.assign(
          new Error("Embedding metadata does not match; full reindex required"),
          { expected: true as const },
        );

        const mcpError = toMcpToolError(error);

        expect(mcpError.details).toEqual({
          name: "Error",
          message: "Embedding metadata does not match; full reindex required",
          code: "embedding_error",
          expected: true,
        });
        expect(mcpError.message).not.toContain("stack");
      });
    });
  });
});

function createRefreshResult(indexed: number): RefreshSearchIndexResult {
  return {
    sync: {
      indexed,
      skipped: 0,
      deleted: 0,
      files: [],
      deletedPaths: [],
    },
    status: {
      vaultPath: "/vault",
      databasePath: "/db.sqlite",
      schemaVersion: 1,
      noteCount: indexed,
      chunkCount: indexed,
      lastIndexedAt: Date.now(),
      sqlite: {
        ok: true,
        walEnabled: true,
        foreignKeysEnabled: true,
        fts5Available: true,
        sqliteVecAvailable: true,
      },
      vectors: {
        ready: true,
        chunkEmbeddingCount: indexed,
        modelId: "test",
        dimension: 1,
        normalized: true,
        chunkerVersion: "test",
      },
    },
  };
}

function createSearchResult(score: number): SearchOutput {
  return {
    chunkId: 7,
    path: "alpha.md",
    title: "Alpha",
    headingPath: ["Alpha"],
    snippet: "A compact match",
    score,
    rank: 1,
    chunkIndex: 0,
    matchedBy: ["keyword"],
  };
}

function createHybridSearchResult(): SearchOutput {
  return {
    chunkId: 7,
    path: "alpha.md",
    title: "Alpha",
    headingPath: ["Alpha"],
    snippet: "A compact match",
    score: 0.032,
    rank: 1,
    chunkIndex: 0,
    matchedBy: ["keyword", "vector", "title"],
    componentScores: {
      keyword: { rank: 1, score: -12 },
      vector: { rank: 2, score: 0.25 },
      title: { rank: 3, score: 4 },
    },
  };
}

function createSemanticSearchResult(): SearchOutput {
  return {
    chunkId: 7,
    path: "alpha.md",
    title: "Alpha",
    headingPath: ["Alpha"],
    snippet: "A compact match",
    score: 0.25,
    rank: 1,
    chunkIndex: 0,
    matchedBy: ["vector"],
  };
}

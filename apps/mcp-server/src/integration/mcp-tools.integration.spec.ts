import {
  readFile,
  mkdir,
  mkdtemp,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createVaultgenticMcpServer } from "../index.js";

type IntegrationFixture = {
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>;
  close: () => Promise<void>;
  vaultPath: string;
};

type SearchToolJson = {
  query: string;
  mode: string;
  results: Array<{
    path: string;
    title: string;
    chunkId: number | null;
    snippet?: string;
    score?: number;
  }>;
  filterDiagnostics?: {
    appliedFilters: { scope?: string; path?: string; tags: string[] };
    matchedNoteCounts: {
      allFilters: number;
      scope?: number;
      path?: number;
      tags: Record<string, number>;
    };
    warnings: string[];
  };
  scoreMetadata?: { kind: string; higherIsBetter: boolean };
};

type ReadToolJson = {
  result:
    | {
        type: "note";
        path: string;
        fileHash: string;
        content: string;
        truncated: boolean;
        originalLength: number;
        metadata?: NoteMetadata;
      }
    | {
        type: "chunk";
        id: number;
        path: string;
        title: string;
        headingPath: string[];
        text: string;
        truncated: boolean;
        originalLength: number;
        noteContext?: NoteMetadata;
      };
};

type NoteMetadata = {
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  frontmatter: Record<string, unknown>;
};

type WriteToolJson = {
  result: {
    path: string;
    operation: "created" | "updated";
    indexed: boolean;
  };
};

type PatchToolJson = {
  result: {
    path: string;
    indexed: boolean;
  };
};

type ErrorToolJson = {
  name: string;
  message: string;
  code: string;
  expected: boolean;
};

type TextContent = {
  type: "text";
  text: string;
};

describe("GIVEN a temporary vault connected through the MCP client", () => {
  describe("WHEN agents combine all vaultgentic tools in a realistic workflow", () => {
    describe("THEN writes reads searches and patches stay consistent end-to-end", () => {
      it("SHOULD create read search patch and re-search a note through MCP", async () => {
        const fixture = await createIntegrationFixture("workflow");
        try {
          const body =
            "# Project Alpha\n\nThe alpha-workflow-needle starts in planning mode.";

          const writeResult = await fixture.callTool("vaultgentic_write", {
            path: "projects/alpha.md",
            body,
            frontmatter: { title: "Project Alpha", status: "draft" },
            tags: ["project", "alpha"],
            aliases: ["Alpha Project"],
          });

          expect(writeResult.isError).toBeUndefined();
          expect(readToolJson<WriteToolJson>(writeResult)).toEqual({
            result: {
              path: "projects/alpha.md",
              operation: "created",
              indexed: true,
            },
          });
          expect(JSON.stringify(writeResult)).not.toContain(
            "alpha-workflow-needle",
          );

          const readResult = await fixture.callTool("vaultgentic_read", {
            target: "projects/alpha.md",
            includeMetadata: true,
          });
          const readJson = readToolJson<ReadToolJson>(readResult);

          expect(readResult.isError).toBeUndefined();
          expect(readJson.result).toMatchObject({
            type: "note",
            path: "projects/alpha.md",
            content: expect.stringContaining("alpha-workflow-needle"),
            metadata: {
              title: "Project Alpha",
              tags: ["project", "alpha"],
              aliases: ["Alpha Project"],
              frontmatter: {
                title: "Project Alpha",
                status: "draft",
              },
            },
          });
          expect(
            readJson.result.type === "note" ? readJson.result.fileHash : "",
          ).toMatch(/^sha256:[a-f0-9]{64}$/u);

          const firstSearch = await fixture.callTool("vaultgentic_search", {
            query: "alpha-workflow-needle",
            mode: "keyword",
            filter: { kind: "scope", scope: "projects/", tags: ["project"] },
          });

          expect(readToolJson<SearchToolJson>(firstSearch).results).toEqual([
            expect.objectContaining({
              path: "projects/alpha.md",
              title: "Project Alpha",
            }),
          ]);

          const fileHash =
            readJson.result.type === "note" ? readJson.result.fileHash : "";
          const patchText = createPatchText(
            "projects/alpha.md",
            "The alpha-workflow-needle starts in planning mode.",
            "The alpha-patched-needle is ready for implementation.",
          );
          const patchResult = await fixture.callTool("vaultgentic_patch", {
            path: "projects/alpha.md",
            patch: patchText,
            expectedFileHash: fileHash,
          });

          expect(patchResult.isError).toBeUndefined();
          expect(readToolJson<PatchToolJson>(patchResult)).toEqual({
            result: { path: "projects/alpha.md", indexed: true },
          });
          expect(JSON.stringify(patchResult)).not.toContain(
            "alpha-patched-needle",
          );

          const patchedRead = readToolJson<ReadToolJson>(
            await fixture.callTool("vaultgentic_read", {
              target: "projects/alpha.md",
              includeMetadata: true,
            }),
          );
          expect(patchedRead.result).toMatchObject({
            type: "note",
            content: expect.stringContaining("alpha-patched-needle"),
          });
          expect(
            patchedRead.result.type === "note"
              ? patchedRead.result.fileHash
              : fileHash,
          ).not.toBe(fileHash);

          const patchedSearch = readToolJson<SearchToolJson>(
            await fixture.callTool("vaultgentic_search", {
              query: "alpha-patched-needle",
              mode: "keyword",
            }),
          );
          expect(patchedSearch.results[0]).toMatchObject({
            path: "projects/alpha.md",
          });
        } finally {
          await fixture.close();
        }
      });
    });
  });

  describe("WHEN agents use vaultgentic_search", () => {
    describe("THEN search behaves end-to-end against indexed vault files", () => {
      it("SHOULD find keyword and title matches with deterministic ranking", async () => {
        const fixture = await createIntegrationFixture("search-basic");
        try {
          await writeVaultFile(
            fixture.vaultPath,
            "projects/alpha.md",
            "---\ntitle: Alpha Roadmap\ntags:\n  - project\n---\n\n# Alpha\n\nUnique alpha-search-needle content.",
          );
          await writeVaultFile(
            fixture.vaultPath,
            "archive/beta.md",
            "---\ntitle: Beta Archive\ntags:\n  - archive\n---\n\n# Beta\n\nDifferent beta content.",
          );

          const keywordResult = readToolJson<SearchToolJson>(
            await fixture.callTool("vaultgentic_search", {
              query: "alpha-search-needle",
              mode: "keyword",
            }),
          );
          const titleResult = readToolJson<SearchToolJson>(
            await fixture.callTool("vaultgentic_search", {
              query: "Alpha Roadmap",
              mode: "title",
            }),
          );

          expect(keywordResult.results[0]).toMatchObject({
            path: "projects/alpha.md",
            title: "Alpha Roadmap",
          });
          expect(titleResult.results[0]).toMatchObject({
            path: "projects/alpha.md",
            title: "Alpha Roadmap",
          });
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD apply scope and tag filters before returning matches", async () => {
        const fixture = await createIntegrationFixture("search-filters");
        try {
          await writeVaultFile(
            fixture.vaultPath,
            "projects/alpha.md",
            "---\ntags:\n  - project\n---\n\n# Alpha\n\nshared-filter-needle alpha.",
          );
          await writeVaultFile(
            fixture.vaultPath,
            "projects/personal.md",
            "---\ntags:\n  - personal\n---\n\n# Personal\n\nshared-filter-needle personal.",
          );
          await writeVaultFile(
            fixture.vaultPath,
            "archive/beta.md",
            "---\ntags:\n  - project\n---\n\n# Beta\n\nshared-filter-needle beta.",
          );

          const result = readToolJson<SearchToolJson>(
            await fixture.callTool("vaultgentic_search", {
              query: "shared-filter-needle",
              mode: "keyword",
              filter: {
                kind: "scope",
                scope: "projects/",
                tags: ["project"],
              },
            }),
          );

          expect(
            result.results.map((searchResult) => searchResult.path),
          ).toEqual(["projects/alpha.md"]);
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD include scores only when callers request them", async () => {
        const fixture = await createIntegrationFixture("search-scores");
        try {
          await writeVaultFile(
            fixture.vaultPath,
            "scored.md",
            "# Scored\n\nscore-toggle-needle appears here.",
          );

          const withoutScores = readToolJson<SearchToolJson>(
            await fixture.callTool("vaultgentic_search", {
              query: "score-toggle-needle",
              mode: "keyword",
            }),
          );
          const withScores = readToolJson<SearchToolJson>(
            await fixture.callTool("vaultgentic_search", {
              query: "score-toggle-needle",
              mode: "keyword",
              includeScores: true,
            }),
          );

          expect(withoutScores.results[0]).not.toHaveProperty("score");
          expect(withoutScores).not.toHaveProperty("scoreMetadata");
          expect(withScores.results[0]?.score).toEqual(expect.any(Number));
          expect(withScores.scoreMetadata).toEqual({
            kind: "relevance",
            higherIsBetter: true,
            description: expect.any(String),
          });
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD return filter diagnostics when filters hide indexed notes", async () => {
        const fixture = await createIntegrationFixture("search-diagnostics");
        try {
          await writeVaultFile(
            fixture.vaultPath,
            "projects/alpha.md",
            "---\ntags:\n  - project\n---\n\n# Alpha\n\ndiagnostic-needle alpha.",
          );

          const result = readToolJson<SearchToolJson>(
            await fixture.callTool("vaultgentic_search", {
              query: "diagnostic-needle",
              mode: "keyword",
              filter: { kind: "scope", scope: "missing/", tags: ["absent"] },
            }),
          );

          expect(result.results).toEqual([]);
          expect(result.filterDiagnostics).toEqual({
            appliedFilters: { scope: "missing/", tags: ["absent"] },
            matchedNoteCounts: {
              allFilters: 0,
              scope: 0,
              tags: { absent: 0 },
            },
            warnings: [
              "No indexed notes match scope: missing/",
              "No indexed notes match tag: absent",
            ],
          });
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD return MCP-shaped validation errors for invalid inputs", async () => {
        const fixture = await createIntegrationFixture("search-invalid");
        try {
          const cases: Array<Record<string, unknown>> = [
            { query: "   " },
            { query: "valid", mode: "invalid" },
            { query: "valid", limit: 0 },
            { query: "valid", scope: "projects/" },
            {
              query: "valid",
              filter: {
                kind: "tags",
                tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
              },
            },
          ];

          for (const input of cases) {
            const result = await fixture.callTool("vaultgentic_search", input);

            expect(result.isError).toBe(true);
            expect(readToolText(result)).toContain("MCP error");
          }
        } finally {
          await fixture.close();
        }
      });
    });
  });

  describe("WHEN agents use vaultgentic_read", () => {
    describe("THEN reads behave end-to-end against files and indexed chunks", () => {
      it("SHOULD read notes with hashes metadata and readable truncation", async () => {
        const fixture = await createIntegrationFixture("read-note");
        try {
          await writeVaultFile(
            fixture.vaultPath,
            "readable.md",
            "---\ntitle: Readable Note\naliases:\n  - Reader\ntags:\n  - docs\n---\n\n# Readable\n\nAlpha beta gamma delta.",
          );

          const result = readToolJson<ReadToolJson>(
            await fixture.callTool("vaultgentic_read", {
              target: "readable.md",
              maxChars: 20,
              includeMetadata: true,
            }),
          );

          expect(result.result).toMatchObject({
            type: "note",
            path: "readable.md",
            fileHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
            content: expect.stringMatching(/---\ntitle: Readable/u),
            truncated: true,
            metadata: {
              path: "readable.md",
              title: "Readable Note",
              aliases: ["Reader"],
              tags: ["docs"],
              frontmatter: {
                title: "Readable Note",
                aliases: ["Reader"],
                tags: ["docs"],
              },
            },
          });
          expect(
            result.result.type === "note" ? result.result.originalLength : 0,
          ).toBeGreaterThan(20);
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD read indexed chunks with optional note context", async () => {
        const fixture = await createIntegrationFixture("read-chunk");
        try {
          await writeVaultFile(
            fixture.vaultPath,
            "chunked.md",
            "---\ntitle: Chunked Note\ntags:\n  - chunked\n---\n\n# Chunked\n\n## Details\n\nchunk-context-needle appears here.",
          );
          const searchResult = readToolJson<SearchToolJson>(
            await fixture.callTool("vaultgentic_search", {
              query: "chunk-context-needle",
              mode: "keyword",
            }),
          );
          const chunkId = searchResult.results[0]?.chunkId;

          const result = readToolJson<ReadToolJson>(
            await fixture.callTool("vaultgentic_read", {
              target: chunkId,
              includeNoteContext: true,
            }),
          );

          expect(chunkId).toEqual(expect.any(Number));
          expect(result.result).toMatchObject({
            type: "chunk",
            id: chunkId,
            path: "chunked.md",
            title: "Chunked Note",
            headingPath: ["Chunked", "Details"],
            text: expect.stringContaining("chunk-context-needle"),
            noteContext: {
              path: "chunked.md",
              title: "Chunked Note",
              tags: ["chunked"],
            },
          });
          expect("fileHash" in result.result).toBe(false);
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD report missing notes stale chunks and unsafe paths as MCP errors", async () => {
        const fixture = await createIntegrationFixture("read-errors");
        try {
          await writeVaultFile(
            fixture.vaultPath,
            "deleted.md",
            "# Deleted\n\nstale-chunk-needle appears here.",
          );
          const searchResult = readToolJson<SearchToolJson>(
            await fixture.callTool("vaultgentic_search", {
              query: "stale-chunk-needle",
              mode: "keyword",
            }),
          );
          const chunkId = searchResult.results[0]?.chunkId;
          await unlink(path.join(fixture.vaultPath, "deleted.md"));

          const missingResult = await fixture.callTool("vaultgentic_read", {
            target: "missing.md",
          });
          const traversalResult = await fixture.callTool("vaultgentic_read", {
            target: "../escape.md",
          });
          const staleChunkResult = await fixture.callTool("vaultgentic_read", {
            target: chunkId,
          });

          expect(missingResult.isError).toBe(true);
          expect(readToolJson<ErrorToolJson>(missingResult)).toMatchObject({
            code: "not_found",
            expected: true,
            message: "Note not found: missing.md",
          });
          expect(traversalResult.isError).toBe(true);
          expect(readToolJson<ErrorToolJson>(traversalResult)).toMatchObject({
            code: "path_rejected",
          });
          expect(staleChunkResult.isError).toBe(true);
          expect(readToolJson<ErrorToolJson>(staleChunkResult)).toMatchObject({
            code: "not_found",
            message: `Chunk not found: ${chunkId}`,
          });
          expect(JSON.stringify(missingResult)).not.toContain(
            fixture.vaultPath,
          );
          expect(JSON.stringify(traversalResult)).not.toContain(
            fixture.vaultPath,
          );
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD return MCP-shaped validation errors for invalid read inputs", async () => {
        const fixture = await createIntegrationFixture("read-invalid");
        try {
          const cases: Array<Record<string, unknown>> = [
            { target: "" },
            { target: "alpha.md", maxChars: 0 },
            { target: "alpha.md", maxChars: 200_001 },
          ];

          for (const input of cases) {
            const result = await fixture.callTool("vaultgentic_read", input);

            expect(result.isError).toBe(true);
            expect(readToolText(result)).toContain("MCP error");
          }

          const ambiguousResult = await fixture.callTool("vaultgentic_read", {
            target: "alpha",
          });
          expect(ambiguousResult.isError).toBe(true);
          expect(readToolJson<ErrorToolJson>(ambiguousResult)).toMatchObject({
            code: "invalid_read_target",
          });
        } finally {
          await fixture.close();
        }
      });
    });
  });

  describe("WHEN agents use vaultgentic_write", () => {
    describe("THEN writes create searchable Obsidian markdown notes", () => {
      it("SHOULD create nested notes update existing notes and preserve frontmatter", async () => {
        const fixture = await createIntegrationFixture("write-create-update");
        try {
          const created = readToolJson<WriteToolJson>(
            await fixture.callTool("vaultgentic_write", {
              path: "deep/path/note.md",
              body: "# Original\n\nwrite-create-needle original.",
              frontmatter: { title: "Writable Note", status: "new" },
              tags: ["write-test"],
              aliases: ["Writable"],
            }),
          );
          const updated = readToolJson<WriteToolJson>(
            await fixture.callTool("vaultgentic_write", {
              path: "deep/path/note.md",
              body: "# Updated\n\nwrite-update-needle updated.",
            }),
          );

          expect(created.result).toEqual({
            path: "deep/path/note.md",
            operation: "created",
            indexed: true,
          });
          expect(updated.result).toEqual({
            path: "deep/path/note.md",
            operation: "updated",
            indexed: true,
          });
          expect(
            await readFile(path.join(fixture.vaultPath, "deep/path/note.md"), {
              encoding: "utf8",
            }),
          ).toContain("status: new");

          const readResult = readToolJson<ReadToolJson>(
            await fixture.callTool("vaultgentic_read", {
              target: "deep/path/note.md",
              includeMetadata: true,
            }),
          );
          const searchResult = readToolJson<SearchToolJson>(
            await fixture.callTool("vaultgentic_search", {
              query: "write-update-needle",
              mode: "keyword",
              filter: { kind: "tags", tags: ["write-test"] },
            }),
          );

          expect(readResult.result).toMatchObject({
            type: "note",
            content: expect.stringContaining("write-update-needle"),
            metadata: {
              title: "Writable Note",
              aliases: ["Writable"],
              tags: ["write-test"],
            },
          });
          expect(searchResult.results[0]).toMatchObject({
            path: "deep/path/note.md",
            title: "Writable Note",
          });
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD reject unsafe paths and invalid frontmatter", async () => {
        const fixture = await createIntegrationFixture("write-errors");
        try {
          const traversalResult = await fixture.callTool("vaultgentic_write", {
            path: "../escape.md",
            body: "# Escape",
          });
          const prototypeResult = await fixture.callTool("vaultgentic_write", {
            path: "safe.md",
            body: "# Safe",
            frontmatter: { "1invalid": "bad key" },
          });
          const unsupportedValueResult = await fixture.callTool(
            "vaultgentic_write",
            {
              path: "safe.md",
              body: "# Safe",
              frontmatter: { a: { b: { c: { d: { e: { f: "too deep" } } } } } },
            },
          );

          expect(traversalResult.isError).toBe(true);
          expect(readToolJson<ErrorToolJson>(traversalResult)).toMatchObject({
            code: "path_rejected",
          });
          expect(prototypeResult.isError).toBe(true);
          expect(readToolText(prototypeResult)).toContain("MCP error");
          expect(unsupportedValueResult.isError).toBe(true);
          expect(readToolText(unsupportedValueResult)).toContain("MCP error");
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD return MCP-shaped validation errors for invalid write inputs", async () => {
        const fixture = await createIntegrationFixture("write-invalid");
        try {
          const cases: Array<Record<string, unknown>> = [
            { path: "", body: "# Alpha" },
            { path: `${"x".repeat(501)}.md`, body: "# Alpha" },
            { path: "alpha.md", body: "x".repeat(200_001) },
            { path: "alpha.md", body: "# Alpha", tags: [""] },
            { path: "alpha.md", body: "# Alpha", aliases: [""] },
          ];

          for (const input of cases) {
            const result = await fixture.callTool("vaultgentic_write", input);

            expect(result.isError).toBe(true);
            expect(readToolText(result)).toContain("MCP error");
          }
        } finally {
          await fixture.close();
        }
      });
    });
  });

  describe("WHEN agents use vaultgentic_patch", () => {
    describe("THEN patches safely mutate existing notes", () => {
      it("SHOULD patch existing notes with matching hashes", async () => {
        const fixture = await createIntegrationFixture("patch-success");
        try {
          await writeVaultFile(
            fixture.vaultPath,
            "patchable.md",
            "# Patchable\n\npatch-success-needle old line.",
          );
          const readResult = readToolJson<ReadToolJson>(
            await fixture.callTool("vaultgentic_read", {
              target: "patchable.md",
            }),
          );
          const fileHash =
            readResult.result.type === "note" ? readResult.result.fileHash : "";

          const result = readToolJson<PatchToolJson>(
            await fixture.callTool("vaultgentic_patch", {
              path: "patchable.md",
              patch: createPatchText(
                "patchable.md",
                "patch-success-needle old line.",
                "patch-success-needle new line.",
              ),
              expectedFileHash: fileHash,
            }),
          );
          const patchedRead = readToolJson<ReadToolJson>(
            await fixture.callTool("vaultgentic_read", {
              target: "patchable.md",
            }),
          );

          expect(result.result).toEqual({
            path: "patchable.md",
            indexed: true,
          });
          expect(patchedRead.result).toMatchObject({
            type: "note",
            content: expect.stringContaining("patch-success-needle new line"),
          });
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD reject stale hashes conflicts missing notes and header mismatches", async () => {
        const fixture = await createIntegrationFixture("patch-errors");
        try {
          await writeVaultFile(
            fixture.vaultPath,
            "patchable.md",
            "# Patchable\n\nfirst patch line.",
          );
          const readResult = readToolJson<ReadToolJson>(
            await fixture.callTool("vaultgentic_read", {
              target: "patchable.md",
            }),
          );
          const staleHash =
            readResult.result.type === "note" ? readResult.result.fileHash : "";
          await fixture.callTool("vaultgentic_write", {
            path: "patchable.md",
            body: "# Patchable\n\nsecond patch line.",
          });

          const staleHashResult = await fixture.callTool("vaultgentic_patch", {
            path: "patchable.md",
            patch: createPatchText(
              "patchable.md",
              "second patch line.",
              "third patch line.",
            ),
            expectedFileHash: staleHash,
          });
          const conflictResult = await fixture.callTool("vaultgentic_patch", {
            path: "patchable.md",
            patch: createPatchText(
              "patchable.md",
              "line that is not present.",
              "replacement.",
            ),
          });
          const missingResult = await fixture.callTool("vaultgentic_patch", {
            path: "missing.md",
            patch: createPatchText("missing.md", "old", "new"),
          });
          const headerMismatchResult = await fixture.callTool(
            "vaultgentic_patch",
            {
              path: "patchable.md",
              patch: createPatchText("other.md", "second patch line.", "new"),
            },
          );

          expect(staleHashResult.isError).toBe(true);
          expect(readToolJson<ErrorToolJson>(staleHashResult)).toMatchObject({
            message: "Expected file hash does not match current note",
          });
          expect(conflictResult.isError).toBe(true);
          expect(readToolJson<ErrorToolJson>(conflictResult)).toMatchObject({
            message:
              'Patch old lines were not found: "line that is not present."',
          });
          expect(missingResult.isError).toBe(true);
          expect(readToolJson<ErrorToolJson>(missingResult)).toMatchObject({
            message: "Patch path must be an existing markdown file",
          });
          expect(headerMismatchResult.isError).toBe(true);
          expect(
            readToolJson<ErrorToolJson>(headerMismatchResult),
          ).toMatchObject({
            message: "Patch headers must match the requested path",
          });
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD apply tolerant matches and reject ambiguous tolerant matches", async () => {
        const fixture = await createIntegrationFixture("patch-tolerant");
        try {
          await writeVaultFile(
            fixture.vaultPath,
            "tolerant.md",
            "# Tolerant\n\n  Ada’s note — old.  \n",
          );
          await writeVaultFile(
            fixture.vaultPath,
            "ambiguous.md",
            "  repeated line.\nrepeated line.  \n",
          );

          const tolerantResult = await fixture.callTool("vaultgentic_patch", {
            path: "tolerant.md",
            patch: createPatchText(
              "tolerant.md",
              "Ada's note - old.",
              "Ada's note is patched.",
            ),
          });
          const ambiguousResult = await fixture.callTool("vaultgentic_patch", {
            path: "ambiguous.md",
            patch: createPatchText(
              "ambiguous.md",
              "repeated line.",
              "patched line.",
            ),
          });

          expect(tolerantResult.isError).toBeUndefined();
          expect(readToolJson<PatchToolJson>(tolerantResult)).toEqual({
            result: { path: "tolerant.md", indexed: true },
          });
          await expect(
            readFile(path.join(fixture.vaultPath, "tolerant.md"), "utf8"),
          ).resolves.toBe("# Tolerant\n\nAda's note is patched.\n");
          expect(ambiguousResult.isError).toBe(true);
          expect(readToolJson<ErrorToolJson>(ambiguousResult)).toMatchObject({
            message:
              "Patch old lines matched multiple locations; add context to disambiguate",
          });
          await expect(
            readFile(path.join(fixture.vaultPath, "ambiguous.md"), "utf8"),
          ).resolves.toBe("  repeated line.\nrepeated line.  \n");
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD reject no-op create delete multi-file unsafe and malformed patches", async () => {
        const fixture = await createIntegrationFixture("patch-invalid-shapes");
        try {
          await writeVaultFile(
            fixture.vaultPath,
            "patchable.md",
            "# Patchable\n\nshape patch line.",
          );

          const cases: Array<{
            input: Record<string, unknown>;
            message: string;
          }> = [
            {
              input: {
                path: "patchable.md",
                patch: createNoOpPatchText("patchable.md", "# Patchable"),
              },
              message: "Patch must change the markdown note",
            },
            {
              input: {
                path: "created.md",
                patch:
                  "*** Begin Patch\n*** Add File: created.md\n+created\n*** End Patch",
              },
              message: "Patch path must be an existing markdown file",
            },
            {
              input: {
                path: "patchable.md",
                patch:
                  "*** Begin Patch\n*** Delete File: patchable.md\n*** End Patch",
              },
              message: "Patch must contain exactly one Update",
            },
            {
              input: {
                path: "patchable.md",
                patch:
                  "*** Begin Patch\n*** Update File: patchable.md\n*** Move to: moved.md\n*** End Patch",
              },
              message: "Patch must update one existing markdown file",
            },
            {
              input: {
                path: "patchable.md",
                patch:
                  "*** Begin Patch\n*** Update File: patchable.md\n*** Copy to: copied.md\n*** End Patch",
              },
              message: "Unsupported patch operation",
            },
            {
              input: {
                path: "patchable.md",
                patch: `${createPatchText(
                  "patchable.md",
                  "shape patch line.",
                  "updated.",
                )}\n${createPatchText("other.md", "old", "new")}`,
              },
              message: "Patch must contain exactly one Update",
            },
            {
              input: {
                path: "../escape.md",
                patch: createPatchText("../escape.md", "old", "new"),
              },
              message: "traversal segments",
            },
            {
              input: {
                path: "patchable.md",
                patch: "not a patch",
              },
              message: "Patch must start with *** Begin Patch",
            },
          ];

          for (const { input, message } of cases) {
            const result = await fixture.callTool("vaultgentic_patch", input);

            expect(result.isError).toBe(true);
            expect(readToolJson<ErrorToolJson>(result).message).toContain(
              message,
            );
          }
        } finally {
          await fixture.close();
        }
      });

      it("SHOULD return MCP-shaped validation errors for invalid patch inputs", async () => {
        const fixture = await createIntegrationFixture("patch-invalid-inputs");
        try {
          const cases: Array<Record<string, unknown>> = [
            { path: "alpha.md", patch: "" },
            { path: "alpha.md", patch: "   \n" },
            { path: "alpha.md", patch: "x".repeat(200_001) },
            {
              path: "alpha.md",
              patch: createPatchText("alpha.md", "old", "new"),
              expectedFileHash: "sha256:not-hex",
            },
          ];

          for (const input of cases) {
            const result = await fixture.callTool("vaultgentic_patch", input);

            expect(result.isError).toBe(true);
            expect(readToolText(result)).toContain("MCP error");
          }
        } finally {
          await fixture.close();
        }
      });
    });
  });
});

async function createIntegrationFixture(
  name: string,
): Promise<IntegrationFixture> {
  const cwd = await mkdtemp(path.join(tmpdir(), `vaultgentic-mcp-${name}-`));
  const vaultPath = path.join(cwd, "vault");
  const databasePath = path.join(cwd, "index.sqlite");
  const configPath = path.join(cwd, "config.json");
  await mkdir(vaultPath, { recursive: true });
  await writeFile(configPath, JSON.stringify({ vaultPath, databasePath }));

  const mcpServer = await createVaultgenticMcpServer({
    configPath,
    refreshThrottleMs: 0,
  });
  const client = new Client({
    name: "vaultgentic-integration",
    version: "test",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcpServer.server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
      await rm(cwd, { recursive: true, force: true });
    },
    vaultPath,
  };
}

async function writeVaultFile(
  vaultPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const absolutePath = path.join(vaultPath, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

function readToolJson<T>(result: CallToolResult): T {
  return JSON.parse(readToolText(result)) as T;
}

function readToolText(result: CallToolResult): string {
  const [content] = result.content ?? [];
  if (!isTextContent(content)) {
    throw new Error("Expected a text MCP tool result");
  }

  return content.text;
}

function isTextContent(content: unknown): content is TextContent {
  return (
    typeof content === "object" &&
    content !== null &&
    "type" in content &&
    content.type === "text" &&
    "text" in content &&
    typeof content.text === "string"
  );
}

function createPatchText(
  filePath: string,
  oldLine: string,
  newLine: string,
): string {
  return [
    "*** Begin Patch",
    `*** Update File: ${filePath}`,
    "@@",
    `-${oldLine}`,
    `+${newLine}`,
    "*** End Patch",
  ].join("\n");
}

function createNoOpPatchText(filePath: string, line: string): string {
  return [
    "*** Begin Patch",
    `*** Update File: ${filePath}`,
    "@@",
    `-${line}`,
    `+${line}`,
    "*** End Patch",
  ].join("\n");
}

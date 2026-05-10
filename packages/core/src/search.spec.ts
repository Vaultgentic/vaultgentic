import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeSearchDatabase } from "./database.js";
import { readSearchFilterDiagnostics, refreshSearchIndex } from "./indexer.js";
import { searchVault } from "./search.js";

describe("GIVEN shared vault search", () => {
  describe("WHEN keyword queries include natural-language context", () => {
    describe("THEN fallback matching still returns indexed notes", () => {
      it("SHOULD find notes by distinctive terms", async () => {
        const config = await createSearchFixture("search-natural-query");
        await writeNote(
          config.vaultPath,
          "alpha.md",
          "# Alpha\n\nOpenCode should find this unique needle.",
        );
        initializeSearchDatabase(config);
        await refreshSearchIndex(config);

        const results = await searchVault(config, {
          query: "Can OpenCode find the unique needle?",
          mode: "keyword",
        });

        expect(results.map((result) => result.path)).toContain("alpha.md");
      });
    });
  });

  describe("WHEN filtering by scope and tags", () => {
    describe("THEN results are restricted before returning to callers", () => {
      it("SHOULD return only matching scoped notes with requested tags", async () => {
        const config = await createSearchFixture("search-filters");
        await writeNote(
          config.vaultPath,
          "projects/alpha.md",
          "---\ntags:\n  - project\n---\n\n# Alpha\n\nsharedneedle alpha",
        );
        await writeNote(
          config.vaultPath,
          "archive/beta.md",
          "---\ntags:\n  - project\n---\n\n# Beta\n\nsharedneedle beta",
        );
        await writeNote(
          config.vaultPath,
          "projects/gamma.md",
          "---\ntags:\n  - personal\n---\n\n# Gamma\n\nsharedneedle gamma",
        );
        initializeSearchDatabase(config);
        await refreshSearchIndex(config);

        const results = await searchVault(config, {
          query: "sharedneedle",
          mode: "keyword",
          scope: "projects/",
          tags: ["project"],
        });

        expect(results.map((result) => result.path)).toEqual([
          "projects/alpha.md",
        ]);
      });

      it("SHOULD report filter diagnostics for unmatched scopes and tags", async () => {
        const config = await createSearchFixture("search-filter-diagnostics");
        await writeNote(
          config.vaultPath,
          "projects/alpha.md",
          "---\ntags:\n  - project\n---\n\n# Alpha\n\nsharedneedle alpha",
        );
        initializeSearchDatabase(config);
        await refreshSearchIndex(config);

        const diagnostics = readSearchFilterDiagnostics(config, {
          scope: "missing/",
          tags: ["absent"],
        });

        expect(diagnostics).toEqual({
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
      });

      it("SHOULD warn when filters match separately but not together", async () => {
        const config = await createSearchFixture(
          "search-combined-filter-diagnostics",
        );
        await writeNote(
          config.vaultPath,
          "projects/alpha.md",
          "---\ntags:\n  - project\n---\n\n# Alpha\n\nsharedneedle alpha",
        );
        await writeNote(
          config.vaultPath,
          "archive/beta.md",
          "---\ntags:\n  - archived\n---\n\n# Beta\n\nsharedneedle beta",
        );
        initializeSearchDatabase(config);
        await refreshSearchIndex(config);

        const diagnostics = readSearchFilterDiagnostics(config, {
          scope: "projects/",
          tags: ["archived"],
        });

        expect(diagnostics).toMatchObject({
          matchedNoteCounts: {
            allFilters: 0,
            scope: 1,
            tags: { archived: 1 },
          },
          warnings: ["No indexed notes match all applied filters"],
        });
      });
    });
  });
});

async function createSearchFixture(name: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), `vaultgentic-${name}-`));
  const vaultPath = path.join(cwd, "vault");
  await mkdir(vaultPath);

  return {
    vaultPath,
    databasePath: path.join(cwd, "index.sqlite"),
    searchLimit: 5,
  };
}

async function writeNote(
  vaultPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = path.join(vaultPath, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeSearchDatabase } from "./database.js";
import { refreshSearchIndex } from "./indexer.js";
import { searchVault } from "./search.js";

describe("GIVEN scoped shared vault search", () => {
  describe("WHEN matching scope prefixes", () => {
    describe("THEN folder boundaries are enforced", () => {
      it("SHOULD NOT match sibling paths that share a raw prefix", async () => {
        const config = await createSearchFixture("scope-boundary");
        await writeNote(
          config.vaultPath,
          "projects/alpha.md",
          "# Alpha\n\nboundaryneedle",
        );
        await writeNote(
          config.vaultPath,
          "projects-secret/beta.md",
          "# Beta\n\nboundaryneedle",
        );
        initializeSearchDatabase(config);
        await refreshSearchIndex(config);

        const results = await searchVault(config, {
          query: "boundaryneedle",
          mode: "keyword",
          scope: "projects",
        });

        expect(results.map((result) => result.path)).toEqual([
          "projects/alpha.md",
        ]);
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

import Database from "better-sqlite3";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeSearchDatabase } from "./database.js";
import { indexVaultFile } from "./indexer.js";
import { readVaultTarget, VaultReadError } from "./read.js";

describe("GIVEN a vault read service", () => {
  describe("WHEN a vault-relative note path is requested", () => {
    describe("THEN note content is read from the vault", () => {
      it("SHOULD return the markdown note content", async () => {
        const config = await createFixture("note-path");
        const content = "# Alpha\n\nReadable note text.";
        await writeFile(path.join(config.vaultPath, "alpha.md"), content);

        const result = await readVaultTarget(config, { target: "alpha.md" });

        expect(result).toMatchObject({
          type: "note",
          path: "alpha.md",
          content,
          truncated: false,
          originalLength: content.length,
        });
      });
    });
  });

  describe("WHEN a numeric chunk id is requested", () => {
    describe("THEN indexed chunk text is read from the database", () => {
      it("SHOULD return chunk content and note context", async () => {
        const config = await createFixture("chunk-id");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "---\ntitle: Alpha\ntags:\n  - read-test\n---\n\n# Alpha\n\n## Details\n\nChunk text appears here.",
        );
        await indexVaultFile(config, "alpha.md");
        const chunkId = readChunkIdByText(
          config.databasePath,
          "Chunk text appears here.",
        );

        const result = await readVaultTarget(config, {
          target: String(chunkId),
          withNoteContext: true,
        });

        expect(result).toMatchObject({
          type: "chunk",
          id: chunkId,
          path: "alpha.md",
          title: "Alpha",
          headingPath: ["Alpha", "Details"],
          text: expect.stringContaining("Chunk text appears here."),
          noteContext: {
            path: "alpha.md",
            title: "Alpha",
            tags: ["read-test"],
          },
        });
      });
    });
  });

  describe("WHEN a max character limit is provided", () => {
    describe("THEN readable text is truncated", () => {
      it("SHOULD include truncation metadata", async () => {
        const config = await createFixture("truncate");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "abcdef");

        const result = await readVaultTarget(config, {
          target: "alpha.md",
          maxChars: 3,
        });

        expect(result).toMatchObject({
          type: "note",
          content: "abc",
          truncated: true,
          originalLength: 6,
        });
      });
    });
  });

  describe("WHEN indexed metadata is requested", () => {
    describe("THEN available note metadata is included", () => {
      it("SHOULD return title, aliases, tags, frontmatter, and links", async () => {
        const config = await createFixture("metadata");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "---\ntitle: Custom Alpha\naliases:\n  - A\ntags:\n  - metadata\n---\n\n# Alpha\n\nSee [[Beta]].",
        );
        await indexVaultFile(config, "alpha.md");

        const result = await readVaultTarget(config, {
          target: "alpha.md",
          withMetadata: true,
        });

        expect(result).toMatchObject({
          type: "note",
          metadata: {
            path: "alpha.md",
            title: "Custom Alpha",
            aliases: ["A"],
            tags: ["metadata"],
            frontmatter: {
              title: "Custom Alpha",
            },
            links: [expect.objectContaining({ target: "Beta" })],
          },
        });
      });
    });
  });

  describe("WHEN an ambiguous string target is requested", () => {
    describe("THEN a clear target error is raised", () => {
      it("SHOULD reject non-md non-numeric targets", async () => {
        const config = await createFixture("ambiguous");

        await expect(
          readVaultTarget(config, { target: "alpha" }),
        ).rejects.toBeInstanceOf(VaultReadError);
      });
    });
  });

  describe("WHEN a path escapes the vault", () => {
    describe("THEN path traversal is rejected", () => {
      it("SHOULD reject outside-vault paths", async () => {
        const config = await createFixture("safe-path");

        await expect(
          readVaultTarget(config, { target: "../escape.md" }),
        ).rejects.toBeInstanceOf(VaultReadError);
      });

      it("SHOULD reject symlinks to outside-vault files", async () => {
        const config = await createFixture("safe-symlink");
        const outsidePath = path.join(
          path.dirname(config.vaultPath),
          "secret.md",
        );
        await writeFile(outsidePath, "outside secret");
        await symlink(outsidePath, path.join(config.vaultPath, "secret.md"));

        await expect(
          readVaultTarget(config, { target: "secret.md" }),
        ).rejects.toThrow("Path must stay inside the vault");
      });
    });
  });

  describe("WHEN a requested note does not exist", () => {
    describe("THEN filesystem failures are localized", () => {
      it("SHOULD use the vault read error type", async () => {
        const config = await createFixture("missing-note");

        await expect(
          readVaultTarget(config, { target: "missing.md" }),
        ).rejects.toBeInstanceOf(VaultReadError);
      });
    });
  });
});

async function createFixture(name: string): Promise<{
  vaultPath: string;
  databasePath: string;
}> {
  const cwd = await mkdtemp(path.join(tmpdir(), `vaultgentic-read-${name}-`));
  const vaultPath = path.join(cwd, "vault");
  const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
  await mkdir(vaultPath, { recursive: true });

  const config = { vaultPath, databasePath };
  initializeSearchDatabase(config);
  return config;
}

function readChunkIdByText(databasePath: string, text: string): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database
      .prepare("SELECT id FROM chunks WHERE text LIKE ? ORDER BY id LIMIT 1")
      .get(`%${text}%`) as { id: number };
    return row.id;
  } finally {
    database.close();
  }
}

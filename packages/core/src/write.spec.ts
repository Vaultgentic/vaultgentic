import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VaultWriteError, writeVaultNote } from "./write.js";

describe("GIVEN a vault write service", () => {
  describe("WHEN a new vault-relative note is written", () => {
    describe("THEN a markdown note is created in the vault", () => {
      it("SHOULD return created metadata without exposing markdown contents", async () => {
        const config = await createFixture("create-note");

        const result = await writeVaultNote(config, {
          path: "notes/alpha.md",
          body: "# Alpha\n\nCreated note.",
        });

        expect(result).toEqual({
          path: "notes/alpha.md",
          operation: "created",
          indexed: false,
          warning:
            "Note was written, but indexing has not run. Search results may be stale.",
        });
        expect(
          await readFile(path.join(config.vaultPath, "notes/alpha.md"), "utf8"),
        ).toBe("# Alpha\n\nCreated note.");
        expect(result).not.toHaveProperty("content");
      });

      it("SHOULD create parent directories for valid note paths", async () => {
        const config = await createFixture("create-parents");

        await writeVaultNote(config, {
          path: "projects/example/alpha.md",
          body: "Nested note.",
        });

        await expect(
          readFile(
            path.join(config.vaultPath, "projects/example/alpha.md"),
            "utf8",
          ),
        ).resolves.toBe("Nested note.");
      });

      it("SHOULD write provided frontmatter before the body", async () => {
        const config = await createFixture("frontmatter");

        await writeVaultNote(config, {
          path: "alpha.md",
          frontmatter: {
            title: "Alpha",
            tags: ["write", "core"],
          },
          body: "Body text.",
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe(
          '---\ntitle: "Alpha"\ntags: ["write", "core"]\n---\n\nBody text.',
        );
      });
    });
  });

  describe("WHEN an existing vault-relative note is written", () => {
    describe("THEN the markdown note is updated in place", () => {
      it("SHOULD return updated metadata", async () => {
        const config = await createFixture("update-note");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.");

        const result = await writeVaultNote(config, {
          path: "alpha.md",
          body: "Updated note.",
        });

        expect(result).toEqual({
          path: "alpha.md",
          operation: "updated",
          indexed: false,
          warning:
            "Note was written, but indexing has not run. Search results may be stale.",
        });
        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("Updated note.");
      });
    });
  });

  describe("WHEN an invalid write target is requested", () => {
    describe("THEN the write is rejected", () => {
      it("SHOULD reject paths outside the vault", async () => {
        const config = await createFixture("outside-vault");

        await expect(
          writeVaultNote(config, {
            path: "../outside.md",
            body: "Nope.",
          }),
        ).rejects.toThrow(VaultWriteError);
      });

      it("SHOULD reject non-markdown paths", async () => {
        const config = await createFixture("non-markdown");

        await expect(
          writeVaultNote(config, {
            path: "alpha.txt",
            body: "Nope.",
          }),
        ).rejects.toThrow("Write path must end with .md");
      });

      it("SHOULD reject parent symlinks that escape the vault", async () => {
        const config = await createFixture("symlink-parent");
        const outsidePath = path.join(
          path.dirname(config.vaultPath),
          "outside",
        );
        await mkdir(outsidePath);
        await symlink(outsidePath, path.join(config.vaultPath, "linked"));

        await expect(
          writeVaultNote(config, {
            path: "linked/alpha.md",
            body: "Nope.",
          }),
        ).rejects.toThrow("Write path parent must stay inside the vault");
      });

      it("SHOULD reject note symlinks before writing", async () => {
        const config = await createFixture("symlink-note");
        const outsidePath = path.join(
          path.dirname(config.vaultPath),
          "outside.md",
        );
        await writeFile(outsidePath, "Outside note.");
        await symlink(outsidePath, path.join(config.vaultPath, "alpha.md"));

        await expect(
          writeVaultNote(config, {
            path: "alpha.md",
            body: "Nope.",
          }),
        ).rejects.toThrow("Write path must not be a symlink");
        await expect(readFile(outsidePath, "utf8")).resolves.toBe(
          "Outside note.",
        );
      });
    });
  });
});

async function createFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `vaultgentic-write-${name}-`));
  const vaultPath = path.join(root, "vault");
  await mkdir(vaultPath, { recursive: true });

  return {
    vaultPath,
    databasePath: path.join(root, "search.db"),
  };
}

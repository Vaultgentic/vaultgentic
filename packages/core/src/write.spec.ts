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
          "---\ntitle: Alpha\ntags:\n  - write\n  - core\n---\nBody text.",
        );
      });

      it("SHOULD clear frontmatter when an empty object is provided", async () => {
        const config = await createFixture("empty-frontmatter-create");

        await writeVaultNote(config, {
          path: "alpha.md",
          frontmatter: {},
          body: "Body text.",
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("Body text.");
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

      it("SHOULD preserve existing frontmatter when frontmatter is omitted", async () => {
        const config = await createFixture("preserve-frontmatter");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          '---\n# keep this comment\ntitle: "Alpha"\n---\nOld note.',
        );

        await writeVaultNote(config, {
          path: "alpha.md",
          body: "Updated note.",
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe(
          '---\n# keep this comment\ntitle: "Alpha"\n---\nUpdated note.',
        );
      });

      it("SHOULD preserve existing empty frontmatter when frontmatter is omitted", async () => {
        const config = await createFixture("preserve-empty-frontmatter");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "---\n---\nOld note.",
        );

        await writeVaultNote(config, {
          path: "alpha.md",
          body: "Updated note.",
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("---\n---\nUpdated note.");
      });

      it("SHOULD update notes whose existing body starts with a thematic break", async () => {
        const config = await createFixture("body-thematic-break");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "----\nOld note.",
        );

        await writeVaultNote(config, {
          path: "alpha.md",
          body: "Updated note.",
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("Updated note.");
      });

      it("SHOULD replace existing frontmatter when provided", async () => {
        const config = await createFixture("replace-frontmatter");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "---\ntitle: Old\n---\nOld note.",
        );

        await writeVaultNote(config, {
          path: "alpha.md",
          frontmatter: { title: "New" },
          body: "Updated note.",
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("---\ntitle: New\n---\nUpdated note.");
      });

      it("SHOULD clear existing frontmatter when an empty object is provided", async () => {
        const config = await createFixture("clear-frontmatter");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "---\ntitle: Alpha\n---\nOld note.",
        );

        await writeVaultNote(config, {
          path: "alpha.md",
          frontmatter: {},
          body: "Updated note.",
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("Updated note.");
      });

      it("SHOULD preserve body text exactly", async () => {
        const config = await createFixture("body-exact");

        await writeVaultNote(config, {
          path: "alpha.md",
          frontmatter: { title: "Alpha" },
          body: "Line 1\r\nLine 2  \n",
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("---\ntitle: Alpha\n---\nLine 1\r\nLine 2  \n");
      });

      it("SHOULD replace malformed existing frontmatter when provided", async () => {
        const config = await createFixture("replace-malformed-frontmatter");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "---\ntitle: [\n---\nOld note.",
        );

        await writeVaultNote(config, {
          path: "alpha.md",
          frontmatter: { title: "New" },
          body: "Updated note.",
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("---\ntitle: New\n---\nUpdated note.");
      });

      it("SHOULD clear malformed existing frontmatter when requested", async () => {
        const config = await createFixture("clear-malformed-frontmatter");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "---\ntitle: [\n---\nOld note.",
        );

        await writeVaultNote(config, {
          path: "alpha.md",
          frontmatter: {},
          body: "Updated note.",
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

      it("SHOULD reject malformed existing frontmatter when preserving", async () => {
        const config = await createFixture("preserve-malformed-frontmatter");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "---\ntitle: [\n---\nOld note.",
        );

        await expect(
          writeVaultNote(config, {
            path: "alpha.md",
            body: "Updated note.",
          }),
        ).rejects.toThrow("Existing frontmatter is malformed");
      });

      it("SHOULD reject bodies that start with frontmatter delimiters", async () => {
        const config = await createFixture("frontmatter-body");

        await expect(
          writeVaultNote(config, {
            path: "alpha.md",
            body: "---\nBody text.",
          }),
        ).rejects.toThrow("Write body must not start with frontmatter");
      });

      it("SHOULD reject empty bodies without non-empty frontmatter", async () => {
        const config = await createFixture("empty-body");

        await expect(
          writeVaultNote(config, {
            path: "alpha.md",
            body: " \n\t",
          }),
        ).rejects.toThrow(
          "Write body must not be empty unless frontmatter is provided",
        );
      });

      it("SHOULD allow empty bodies with non-empty frontmatter", async () => {
        const config = await createFixture("empty-body-frontmatter");

        await writeVaultNote(config, {
          path: "alpha.md",
          frontmatter: { title: "Alpha" },
          body: "",
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("---\ntitle: Alpha\n---\n");
      });

      it("SHOULD reject absolute paths before resolving", async () => {
        const config = await createFixture("absolute-path");

        await expect(
          writeVaultNote(config, {
            path: path.join(config.vaultPath, "alpha.md"),
            body: "Nope.",
          }),
        ).rejects.toThrow("Write path must be vault-relative");
      });

      it("SHOULD reject backslashes before resolving", async () => {
        const config = await createFixture("backslash-path");

        await expect(
          writeVaultNote(config, {
            path: "notes\\alpha.md",
            body: "Nope.",
          }),
        ).rejects.toThrow("Write path must use forward slashes");
      });

      it("SHOULD reject non-lowercase markdown extensions", async () => {
        const config = await createFixture("uppercase-extension");

        await expect(
          writeVaultNote(config, {
            path: "alpha.MD",
            body: "Nope.",
          }),
        ).rejects.toThrow("Write path must end with lowercase .md");
      });

      it("SHOULD reject hidden files and folders", async () => {
        const config = await createFixture("hidden-segments");

        await expect(
          writeVaultNote(config, {
            path: "notes/.alpha.md",
            body: "Nope.",
          }),
        ).rejects.toThrow("Write path must not contain hidden segments");
      });

      it("SHOULD reject control characters", async () => {
        const config = await createFixture("control-character");

        await expect(
          writeVaultNote(config, {
            path: "notes/alpha\u0000.md",
            body: "Nope.",
          }),
        ).rejects.toThrow("Write path must not contain control characters");
      });

      it("SHOULD reject Windows-reserved characters", async () => {
        const config = await createFixture("windows-reserved");

        await expect(
          writeVaultNote(config, {
            path: "notes/al:pha.md",
            body: "Nope.",
          }),
        ).rejects.toThrow(
          "Write path must not contain Windows-reserved characters",
        );
      });

      it("SHOULD reject non-markdown paths", async () => {
        const config = await createFixture("non-markdown");

        await expect(
          writeVaultNote(config, {
            path: "alpha.txt",
            body: "Nope.",
          }),
        ).rejects.toThrow("Write path must end with lowercase .md");
      });

      it("SHOULD reject existing directory targets", async () => {
        const config = await createFixture("directory-target");
        await mkdir(path.join(config.vaultPath, "alpha.md"));

        await expect(
          writeVaultNote(config, {
            path: "alpha.md",
            body: "Nope.",
          }),
        ).rejects.toThrow("Write path already exists and is not a file");
      });

      it("SHOULD reject existing non-UTF-8 markdown files", async () => {
        const config = await createFixture("non-utf8");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          Uint8Array.from([0xff, 0xfe]),
        );

        await expect(
          writeVaultNote(config, {
            path: "alpha.md",
            body: "Nope.",
          }),
        ).rejects.toThrow("Existing markdown file must be readable UTF-8");
      });

      it("SHOULD reject invalid paths before creating parent folders", async () => {
        const config = await createFixture("no-parent-mutation");

        await expect(
          writeVaultNote(config, {
            path: ".hidden/alpha.md",
            body: "Nope.",
          }),
        ).rejects.toThrow("Write path must not contain hidden segments");
        await expect(
          readFile(path.join(config.vaultPath, ".hidden/alpha.md"), "utf8"),
        ).rejects.toThrow();
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

      it("SHOULD reject note symlinks that escape the vault", async () => {
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
        ).rejects.toThrow("Write path parent must stay inside the vault");
        await expect(readFile(outsidePath, "utf8")).resolves.toBe(
          "Outside note.",
        );
      });

      it("SHOULD allow symlinks that resolve inside the vault", async () => {
        const config = await createFixture("symlink-inside");
        await mkdir(path.join(config.vaultPath, "actual"));
        await symlink(
          path.join(config.vaultPath, "actual"),
          path.join(config.vaultPath, "linked"),
        );

        await writeVaultNote(config, {
          path: "linked/alpha.md",
          body: "Inside symlink note.",
        });

        await expect(
          readFile(path.join(config.vaultPath, "actual/alpha.md"), "utf8"),
        ).resolves.toBe("Inside symlink note.");
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

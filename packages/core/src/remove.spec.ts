import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchDatabaseConfig } from "./database.js";
import type { RemoveIndexedPathResult } from "./indexer.js";
import { removeVaultNote, VaultRemoveError } from "./remove.js";

const { removeIndexedVaultPathMock } = vi.hoisted(() => ({
  removeIndexedVaultPathMock: vi.fn(),
}));

vi.mock("./indexer.js", () => ({
  removeIndexedVaultPath: removeIndexedVaultPathMock,
}));

describe("GIVEN a vault remove service", () => {
  beforeEach(() => {
    removeIndexedVaultPathMock.mockReset();
    removeIndexedVaultPathMock.mockImplementation(
      (
        _config: SearchDatabaseConfig,
        vaultRelativePath: string,
      ): RemoveIndexedPathResult => ({
        path: vaultRelativePath,
        deleted: true,
      }),
    );
  });

  describe("WHEN an existing markdown note is removed with archive defaults", () => {
    describe("THEN the note is moved to the archive and removed from the index", () => {
      it("SHOULD return metadata without exposing markdown contents", async () => {
        const config = await createFixture("archive-default");
        await mkdir(path.join(config.vaultPath, "notes"), { recursive: true });
        await writeFile(
          path.join(config.vaultPath, "notes/alpha.md"),
          "# Alpha\n\nArchived note.",
        );

        const result = await removeVaultNote(config, {
          path: "notes/alpha.md",
        });

        expect(result).toEqual({
          path: "notes/alpha.md",
          operation: "archived",
          archivedPath: "_archives/notes/alpha.md",
          indexRemoved: true,
          prunedDirectories: [],
        });
        await expect(
          readFile(path.join(config.vaultPath, "notes/alpha.md"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          readFile(
            path.join(config.vaultPath, "_archives/notes/alpha.md"),
            "utf8",
          ),
        ).resolves.toBe("# Alpha\n\nArchived note.");
        expect(removeIndexedVaultPathMock).toHaveBeenCalledWith(
          config,
          "notes/alpha.md",
        );
        expect(result).not.toHaveProperty("content");
      });

      it("SHOULD avoid overwriting an existing archived note", async () => {
        const config = await createFixture("archive-collision");
        await mkdir(path.join(config.vaultPath, "_archives"), {
          recursive: true,
        });
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "Current note.",
        );
        await writeFile(
          path.join(config.vaultPath, "_archives/alpha.md"),
          "Existing archive.",
        );

        const result = await removeVaultNote(config, { path: "alpha.md" });

        expect(result).toMatchObject({
          operation: "archived",
          archivedPath: "_archives/alpha (1).md",
        });
        await expect(
          readFile(path.join(config.vaultPath, "_archives/alpha.md"), "utf8"),
        ).resolves.toBe("Existing archive.");
        await expect(
          readFile(
            path.join(config.vaultPath, "_archives/alpha (1).md"),
            "utf8",
          ),
        ).resolves.toBe("Current note.");
      });
    });
  });

  describe("WHEN archive removes are disabled", () => {
    describe("THEN the existing markdown note is permanently deleted", () => {
      it("SHOULD delete the file and return delete metadata", async () => {
        const config = await createFixture("delete-note");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Delete me.");

        const result = await removeVaultNote(
          { ...config, archiveOnRemove: false },
          { path: "alpha.md" },
        );

        expect(result).toEqual({
          path: "alpha.md",
          operation: "deleted",
          indexRemoved: true,
          prunedDirectories: [],
        });
        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
      });
    });
  });

  describe("WHEN an expected file hash is provided", () => {
    describe("THEN the current markdown must match before removal", () => {
      it("SHOULD remove the note when the hash matches", async () => {
        const config = await createFixture("hash-match");
        const markdown = "Hash protected note.";
        await writeFile(path.join(config.vaultPath, "alpha.md"), markdown);

        const result = await removeVaultNote(config, {
          path: "alpha.md",
          expectedFileHash: hashMarkdown(markdown),
        });

        expect(result).toMatchObject({
          path: "alpha.md",
          operation: "archived",
        });
      });

      it("SHOULD NOT remove or deindex the note when the hash does not match", async () => {
        const config = await createFixture("hash-mismatch");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "Current note.",
        );

        await expect(
          removeVaultNote(config, {
            path: "alpha.md",
            expectedFileHash: hashMarkdown("Different note."),
          }),
        ).rejects.toThrow("Expected file hash does not match current note");
        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("Current note.");
        expect(removeIndexedVaultPathMock).not.toHaveBeenCalled();
      });
    });
  });

  describe("WHEN index cleanup fails after filesystem removal", () => {
    describe("THEN the removal succeeds with a stale-index warning", () => {
      it("SHOULD return a warning without exposing index internals", async () => {
        const config = await createFixture("index-failure");
        const indexError = new Error("database unavailable");
        indexError.stack = "stack trace should stay internal";
        removeIndexedVaultPathMock.mockImplementationOnce(() => {
          throw indexError;
        });
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Archive me.");

        const result = await removeVaultNote(config, { path: "alpha.md" });

        expect(result).toEqual({
          path: "alpha.md",
          operation: "archived",
          archivedPath: "_archives/alpha.md",
          indexRemoved: false,
          prunedDirectories: [],
          warning:
            "Note was removed, but search index cleanup failed. Search results may be stale.",
        });
        expect(result.warning).not.toContain("stack trace");
      });
    });
  });

  describe("WHEN the remove target is invalid", () => {
    describe("THEN the note is not removed", () => {
      it("SHOULD require an existing markdown file", async () => {
        const config = await createFixture("missing-note");

        await expect(
          removeVaultNote(config, { path: "missing.md" }),
        ).rejects.toThrow("Remove path must be an existing markdown file");
      });

      it("SHOULD use the localized remove error type", async () => {
        const config = await createFixture("path-traversal");

        await expect(
          removeVaultNote(config, { path: "../escape.md" }),
        ).rejects.toBeInstanceOf(VaultRemoveError);
      });

      it("SHOULD NOT create archive directories through symlinks outside the vault", async () => {
        const config = await createFixture("archive-symlink-outside");
        const outsidePath = path.join(
          path.dirname(config.vaultPath),
          "outside",
        );
        await mkdir(outsidePath);
        await writeFile(path.join(config.vaultPath, "alpha.md"), "No escape.");
        await symlink(outsidePath, path.join(config.vaultPath, "_archives"));

        await expect(
          removeVaultNote(config, { path: "alpha.md" }),
        ).rejects.toThrow("Write path parent must stay inside the vault");
        await expect(readdir(outsidePath)).resolves.toEqual([]);
        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("No escape.");
        expect(removeIndexedVaultPathMock).not.toHaveBeenCalled();
      });
    });
  });

  describe("WHEN empty parent pruning is enabled", () => {
    describe("THEN only empty nested parents below the top level are removed", () => {
      it("SHOULD report pruned directories after archiving the note", async () => {
        const config = await createFixture("prune-empty-parents");
        await mkdir(path.join(config.vaultPath, "projects/acme/tasks"), {
          recursive: true,
        });
        await writeFile(
          path.join(config.vaultPath, "projects/acme/tasks/todo.md"),
          "Archive me.",
        );

        const result = await removeVaultNote(config, {
          path: "projects/acme/tasks/todo.md",
        });

        expect(result).toMatchObject({
          path: "projects/acme/tasks/todo.md",
          operation: "archived",
          prunedDirectories: ["projects/acme/tasks", "projects/acme"],
        });
        await expect(
          readdir(path.join(config.vaultPath, "projects/acme")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          readdir(path.join(config.vaultPath, "projects")),
        ).resolves.toEqual([]);
      });

      it("SHOULD stop pruning at a non-empty parent directory", async () => {
        const config = await createFixture("prune-non-empty-stop");
        await mkdir(path.join(config.vaultPath, "projects/acme/tasks"), {
          recursive: true,
        });
        await writeFile(
          path.join(config.vaultPath, "projects/acme/tasks/todo.md"),
          "Archive me.",
        );
        await writeFile(
          path.join(config.vaultPath, "projects/acme/overview.md"),
          "Keep parent.",
        );

        const result = await removeVaultNote(config, {
          path: "projects/acme/tasks/todo.md",
        });

        expect(result.prunedDirectories).toEqual(["projects/acme/tasks"]);
        await expect(
          readFile(path.join(config.vaultPath, "projects/acme/overview.md")),
        ).resolves.toBeDefined();
      });
    });
  });

  describe("WHEN empty parent pruning is disabled", () => {
    describe("THEN source directories are left in place", () => {
      it("SHOULD skip pruning and report no pruned directories", async () => {
        const config = await createFixture("prune-disabled");
        await mkdir(path.join(config.vaultPath, "projects/acme/tasks"), {
          recursive: true,
        });
        await writeFile(
          path.join(config.vaultPath, "projects/acme/tasks/todo.md"),
          "Delete me.",
        );

        const result = await removeVaultNote(config, {
          path: "projects/acme/tasks/todo.md",
          pruneEmptyParents: false,
        });

        expect(result.prunedDirectories).toEqual([]);
        await expect(
          readdir(path.join(config.vaultPath, "projects/acme/tasks")),
        ).resolves.toEqual([]);
      });
    });
  });
});

async function createFixture(name: string) {
  const root = await mkdtemp(
    path.join(tmpdir(), `vaultgentic-remove-${name}-`),
  );
  const vaultPath = path.join(root, "vault");
  await mkdir(vaultPath, { recursive: true });

  return {
    vaultPath,
    databasePath: path.join(root, "search.db"),
  };
}

function hashMarkdown(markdown: string): string {
  return `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`;
}

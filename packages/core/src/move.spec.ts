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
import type { IndexFileResult, RemoveIndexedPathResult } from "./indexer.js";
import { moveVaultNote, VaultMoveError } from "./move.js";

const { indexVaultFileMock, removeIndexedVaultPathMock } = vi.hoisted(() => ({
  indexVaultFileMock: vi.fn(),
  removeIndexedVaultPathMock: vi.fn(),
}));

vi.mock("./indexer.js", () => ({
  indexVaultFile: indexVaultFileMock,
  removeIndexedVaultPath: removeIndexedVaultPathMock,
}));

describe("GIVEN a vault move service", () => {
  beforeEach(() => {
    indexVaultFileMock.mockReset();
    indexVaultFileMock.mockImplementation(
      async (
        _config: SearchDatabaseConfig,
        vaultRelativePath: string,
      ): Promise<IndexFileResult> => ({
        path: vaultRelativePath,
        status: "indexed",
        chunkCount: 1,
      }),
    );
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

  describe("WHEN an existing markdown note is moved", () => {
    describe("THEN the note changes paths without archiving the source", () => {
      it("SHOULD move the note create destination parents and update the index", async () => {
        const config = await createFixture("move-note");
        await mkdir(path.join(config.vaultPath, "projects/acme/tasks"), {
          recursive: true,
        });
        await writeFile(
          path.join(config.vaultPath, "projects/acme/tasks/todo.md"),
          "Move me.",
        );

        const result = await moveVaultNote(config, {
          fromPath: "projects/acme/tasks/todo.md",
          toPath: "areas/acme/todo.md",
        });

        expect(result).toEqual({
          fromPath: "projects/acme/tasks/todo.md",
          toPath: "areas/acme/todo.md",
          moved: true,
          overwritten: false,
          prunedDirectories: ["projects/acme/tasks", "projects/acme"],
        });
        await expect(
          readFile(path.join(config.vaultPath, "areas/acme/todo.md"), "utf8"),
        ).resolves.toBe("Move me.");
        await expect(
          readFile(
            path.join(config.vaultPath, "projects/acme/tasks/todo.md"),
            "utf8",
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          readdir(path.join(config.vaultPath, "_archives")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(removeIndexedVaultPathMock).toHaveBeenCalledWith(
          config,
          "projects/acme/tasks/todo.md",
        );
        expect(indexVaultFileMock).toHaveBeenCalledWith(
          config,
          "areas/acme/todo.md",
        );
      });

      it("SHOULD rename a note within its folder", async () => {
        const config = await createFixture("rename-note");
        await mkdir(path.join(config.vaultPath, "notes"));
        await writeFile(path.join(config.vaultPath, "notes/old.md"), "Rename.");

        const result = await moveVaultNote(config, {
          fromPath: "notes/old.md",
          toPath: "notes/new.md",
        });

        expect(result).toMatchObject({
          fromPath: "notes/old.md",
          toPath: "notes/new.md",
          moved: true,
          prunedDirectories: [],
        });
        await expect(
          readFile(path.join(config.vaultPath, "notes/new.md"), "utf8"),
        ).resolves.toBe("Rename.");
      });
    });
  });

  describe("WHEN the move request is unsafe or stale", () => {
    describe("THEN no filesystem or index mutation occurs", () => {
      it("SHOULD require an existing markdown source", async () => {
        const config = await createFixture("missing-source");

        await expect(
          moveVaultNote(config, {
            fromPath: "missing.md",
            toPath: "notes/missing.md",
          }),
        ).rejects.toThrow("Move source must be an existing markdown file");
      });

      it("SHOULD reject path traversal", async () => {
        const config = await createFixture("path-traversal");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Safe.");

        await expect(
          moveVaultNote(config, {
            fromPath: "alpha.md",
            toPath: "../escape.md",
          }),
        ).rejects.toBeInstanceOf(VaultMoveError);
        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("Safe.");
        expect(removeIndexedVaultPathMock).not.toHaveBeenCalled();
      });

      it("SHOULD reject a stale expected file hash", async () => {
        const config = await createFixture("stale-hash");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Current.");

        await expect(
          moveVaultNote(config, {
            fromPath: "alpha.md",
            toPath: "beta.md",
            expectedFileHash: hashMarkdown("Old."),
          }),
        ).rejects.toThrow("Expected file hash does not match current note");
        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("Current.");
        expect(removeIndexedVaultPathMock).not.toHaveBeenCalled();
      });

      it("SHOULD reject source symlinks", async () => {
        const config = await createFixture("source-symlink");
        await writeFile(path.join(config.vaultPath, "target.md"), "Target.");
        await symlink("target.md", path.join(config.vaultPath, "linked.md"));

        await expect(
          moveVaultNote(config, {
            fromPath: "linked.md",
            toPath: "moved.md",
          }),
        ).rejects.toThrow("Move source must be a regular markdown file");
        await expect(
          readFile(path.join(config.vaultPath, "target.md"), "utf8"),
        ).resolves.toBe("Target.");
        expect(removeIndexedVaultPathMock).not.toHaveBeenCalled();
      });
    });
  });

  describe("WHEN the destination already exists", () => {
    describe("THEN overwrite must be explicitly enabled", () => {
      it("SHOULD reject existing destinations by default", async () => {
        const config = await createFixture("destination-exists");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Alpha.");
        await writeFile(path.join(config.vaultPath, "beta.md"), "Beta.");

        await expect(
          moveVaultNote(config, { fromPath: "alpha.md", toPath: "beta.md" }),
        ).rejects.toThrow(
          "Move destination already exists; pass overwrite=true to replace it",
        );
        await expect(
          readFile(path.join(config.vaultPath, "beta.md"), "utf8"),
        ).resolves.toBe("Beta.");
      });

      it("SHOULD overwrite existing destinations when requested", async () => {
        const config = await createFixture("destination-overwrite");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Alpha.");
        await writeFile(path.join(config.vaultPath, "beta.md"), "Beta.");

        const result = await moveVaultNote(config, {
          fromPath: "alpha.md",
          toPath: "beta.md",
          overwrite: true,
        });

        expect(result).toMatchObject({
          fromPath: "alpha.md",
          toPath: "beta.md",
          overwritten: true,
        });
        await expect(
          readFile(path.join(config.vaultPath, "beta.md"), "utf8"),
        ).resolves.toBe("Alpha.");
      });
    });
  });

  describe("WHEN source parent pruning is disabled", () => {
    describe("THEN empty source directories are retained", () => {
      it("SHOULD skip pruning and report no pruned directories", async () => {
        const config = await createFixture("prune-disabled");
        await mkdir(path.join(config.vaultPath, "projects/acme/tasks"), {
          recursive: true,
        });
        await writeFile(
          path.join(config.vaultPath, "projects/acme/tasks/todo.md"),
          "Move me.",
        );

        const result = await moveVaultNote(config, {
          fromPath: "projects/acme/tasks/todo.md",
          toPath: "projects/acme/done.md",
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
  const root = await mkdtemp(path.join(tmpdir(), `vaultgentic-move-${name}-`));
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

import Database from "better-sqlite3";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeSearchDatabase, schemaVersion } from "./database.js";

describe("GIVEN SQLite search database initialization", () => {
  describe("WHEN initializing a new database", () => {
    describe("THEN schema and metadata are created", () => {
      it("SHOULD create the expected tables and status", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-db-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
        await mkdir(vaultPath);

        const status = initializeSearchDatabase({ vaultPath, databasePath });

        expect(status).toMatchObject({
          vaultPath,
          databasePath,
          schemaVersion,
          noteCount: 0,
          chunkCount: 0,
          lastIndexedAt: null,
          sqlite: {
            ok: true,
            walEnabled: true,
            foreignKeysEnabled: true,
          },
        });

        const database = new Database(databasePath, { readonly: true });
        try {
          const expectedTables = ["index_metadata", "notes", "chunks"];
          if (status.sqlite.fts5Available) {
            expectedTables.push("chunks_fts");
          }
          expect(readTableNames(database)).toEqual(
            expect.arrayContaining(expectedTables),
          );
          expect(readMetadata(database)).toMatchObject({
            schema_version: String(schemaVersion),
            vault_root: vaultPath,
            embedding_model_id: "",
            embedding_dimension: "",
            embedding_normalized: "",
            chunker_version: "",
          });
        } finally {
          database.close();
        }
      });
    });
  });

  describe("WHEN initializing an existing database", () => {
    describe("THEN the operation is idempotent", () => {
      it("SHOULD preserve existing metadata and counts", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-db-existing-"),
        );
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
        await mkdir(vaultPath);

        initializeSearchDatabase({ vaultPath, databasePath });
        const secondStatus = initializeSearchDatabase({
          vaultPath,
          databasePath,
        });

        expect(secondStatus.schemaVersion).toBe(schemaVersion);
        expect(secondStatus.noteCount).toBe(0);
        expect(secondStatus.chunkCount).toBe(0);
      });
    });
  });

  describe("WHEN an existing database belongs to another vault", () => {
    describe("THEN initialization is rejected", () => {
      it("SHOULD fail before reporting healthy status", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-db-mismatched-vault-"),
        );
        const vaultPath = path.join(cwd, "vault");
        const otherVaultPath = path.join(cwd, "other-vault");
        const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
        await mkdir(vaultPath);
        await mkdir(otherVaultPath);

        initializeSearchDatabase({ vaultPath, databasePath });

        expect(() =>
          initializeSearchDatabase({
            vaultPath: otherVaultPath,
            databasePath,
          }),
        ).toThrow("vault root mismatch");
      });
    });
  });

  describe("WHEN an existing database has an unsupported schema version", () => {
    describe("THEN initialization is rejected", () => {
      it("SHOULD fail before reporting healthy status", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-db-bad-schema-"),
        );
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
        await mkdir(vaultPath);

        initializeSearchDatabase({ vaultPath, databasePath });

        const database = new Database(databasePath);
        try {
          database
            .prepare("UPDATE index_metadata SET value = ? WHERE key = ?")
            .run("999", "schema_version");
        } finally {
          database.close();
        }

        expect(() =>
          initializeSearchDatabase({ vaultPath, databasePath }),
        ).toThrow("Unsupported database schema version");
      });
    });
  });

  describe("WHEN an existing SQLite database is not a Vaultgentic database", () => {
    describe("THEN initialization is rejected", () => {
      it("SHOULD not stamp missing metadata onto the database", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-db-foreign-"),
        );
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
        await mkdir(vaultPath);
        await mkdir(path.dirname(databasePath));

        const database = new Database(databasePath);
        try {
          database.exec("CREATE TABLE other_app (id INTEGER PRIMARY KEY)");
        } finally {
          database.close();
        }

        expect(() =>
          initializeSearchDatabase({ vaultPath, databasePath }),
        ).toThrow("missing Vaultgentic metadata");
      });
    });
  });
});

function readTableNames(database: Database.Database): string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

function readMetadata(database: Database.Database): Record<string, string> {
  return Object.fromEntries(
    database
      .prepare("SELECT key, value FROM index_metadata")
      .all()
      .map((row) => {
        const metadataRow = row as { key: string; value: string };
        return [metadataRow.key, metadataRow.value];
      }),
  );
}

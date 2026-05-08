import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultIgnoredPaths,
  getDefaultConfigPath,
  loadConfig,
  resolveVaultRelativePath,
} from "./config.js";
import {
  initializeSearchDatabase,
  schemaVersion,
  vaultgenticCoreName,
} from "./index.js";

describe("GIVEN the core package", () => {
  describe("WHEN importing its public entrypoint", () => {
    describe("THEN workspace wiring is available", () => {
      test("SHOULD expose the core package name", () => {
        expect(vaultgenticCoreName).toBe("vaultgentic-core");
      });
    });
  });
});

describe("GIVEN Vaultgentic config loading", () => {
  describe("WHEN loading a valid explicit config path", () => {
    describe("THEN paths are resolved and ignored paths are merged", () => {
      test("SHOULD return a resolved minimal config", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-config-"));
        await mkdir(path.join(cwd, "vault"));
        const configPath = path.join(cwd, "custom-config.json");
        await writeFile(
          configPath,
          JSON.stringify({
            vaultPath: "vault",
            databasePath: ".vaultgentic/index.sqlite",
            ignoredPaths: ["archive", ".git"],
          }),
        );

        await expect(loadConfig({ configPath, cwd })).resolves.toEqual({
          vaultPath: path.join(cwd, "vault"),
          databasePath: path.join(cwd, ".vaultgentic/index.sqlite"),
          ignoredPaths: [...defaultIgnoredPaths, "archive"],
        });
      });
    });
  });

  describe("WHEN loading from the default config location", () => {
    describe("THEN the OS config directory is used", () => {
      test("SHOULD load config.json from XDG_CONFIG_HOME on Linux", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-default-config-"),
        );
        const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
        const previousVaultgenticConfig = process.env.VAULTGENTIC_CONFIG;
        process.env.XDG_CONFIG_HOME = cwd;
        Reflect.deleteProperty(process.env, "VAULTGENTIC_CONFIG");
        await mkdir(path.join(cwd, "vaultgentic"));
        await writeFile(
          path.join(cwd, "vaultgentic", "config.json"),
          JSON.stringify({
            vaultPath: "/tmp/example-vault",
            databasePath: "/tmp/example.sqlite",
          }),
        );

        try {
          await expect(loadConfig({ cwd })).resolves.toMatchObject({
            vaultPath: "/tmp/example-vault",
            databasePath: "/tmp/example.sqlite",
          });
        } finally {
          if (previousXdgConfigHome === undefined) {
            Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
          } else {
            process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
          }

          if (previousVaultgenticConfig === undefined) {
            Reflect.deleteProperty(process.env, "VAULTGENTIC_CONFIG");
          } else {
            process.env.VAULTGENTIC_CONFIG = previousVaultgenticConfig;
          }
        }
      });
    });
  });

  describe("WHEN resolving the default config path", () => {
    describe("THEN platform conventions are used", () => {
      test("SHOULD use ~/.config/vaultgentic/config.json on Linux", () => {
        expect(
          getDefaultConfigPath({
            platform: "linux",
            env: {},
            homeDirectory: "/home/example",
          }),
        ).toBe("/home/example/.config/vaultgentic/config.json");
      });

      test("SHOULD use XDG_CONFIG_HOME on Linux when set", () => {
        expect(
          getDefaultConfigPath({
            platform: "linux",
            env: { XDG_CONFIG_HOME: "/custom/config" },
            homeDirectory: "/home/example",
          }),
        ).toBe("/custom/config/vaultgentic/config.json");
      });

      test("SHOULD use APPDATA on Windows when set", () => {
        expect(
          getDefaultConfigPath({
            platform: "win32",
            env: { APPDATA: "C:\\Users\\Example\\AppData\\Roaming" },
            homeDirectory: "C:\\Users\\Example",
          }),
        ).toBe(
          "C:\\Users\\Example\\AppData\\Roaming\\vaultgentic\\config.json",
        );
      });
    });
  });

  describe("WHEN VAULTGENTIC_CONFIG is set", () => {
    describe("THEN it is used when no explicit config path is provided", () => {
      test("SHOULD load the environment-selected config", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-env-config-"),
        );
        await writeFile(
          path.join(cwd, "env-config.json"),
          JSON.stringify({ vaultPath: "vault", databasePath: "db.sqlite" }),
        );
        const previousConfigPath = process.env.VAULTGENTIC_CONFIG;
        process.env.VAULTGENTIC_CONFIG = "env-config.json";

        try {
          await expect(loadConfig({ cwd })).resolves.toMatchObject({
            vaultPath: path.join(cwd, "vault"),
            databasePath: path.join(cwd, "db.sqlite"),
          });
        } finally {
          if (previousConfigPath === undefined) {
            Reflect.deleteProperty(process.env, "VAULTGENTIC_CONFIG");
          } else {
            process.env.VAULTGENTIC_CONFIG = previousConfigPath;
          }
        }
      });
    });
  });

  describe("WHEN the config cannot be read", () => {
    describe("THEN a clear error is thrown", () => {
      test("SHOULD include the missing config path", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-missing-config-"),
        );

        await expect(loadConfig({ cwd })).rejects.toThrow(
          getDefaultConfigPath(),
        );
      });
    });
  });

  describe("WHEN the config JSON is invalid", () => {
    describe("THEN a clear error is thrown", () => {
      test("SHOULD explain that JSON parsing failed", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-invalid-json-"),
        );
        const configPath = path.join(cwd, "config.json");
        await writeFile(configPath, "{");

        await expect(loadConfig({ configPath, cwd })).rejects.toThrow(
          "Invalid config JSON",
        );
      });
    });
  });

  describe("WHEN required config fields are missing", () => {
    describe("THEN clear validation errors are thrown", () => {
      test("SHOULD require vaultPath", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-missing-vault-"),
        );
        await writeFile(
          path.join(cwd, "config.json"),
          JSON.stringify({ databasePath: "db.sqlite" }),
        );

        await expect(
          loadConfig({ configPath: "config.json", cwd }),
        ).rejects.toThrow("vaultPath");
      });

      test("SHOULD require databasePath", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-missing-database-"),
        );
        await writeFile(
          path.join(cwd, "config.json"),
          JSON.stringify({ vaultPath: "vault" }),
        );

        await expect(
          loadConfig({ configPath: "config.json", cwd }),
        ).rejects.toThrow("databasePath");
      });
    });
  });
});

describe("GIVEN vault-relative path resolution", () => {
  describe("WHEN a path stays inside the vault", () => {
    describe("THEN it is returned as a public vault-relative path", () => {
      test("SHOULD normalize nested paths", () => {
        expect(resolveVaultRelativePath("/tmp/vault", "folder/note.md")).toBe(
          "folder/note.md",
        );
      });

      test("SHOULD normalize backslash separators", () => {
        expect(resolveVaultRelativePath("/tmp/vault", "folder\\note.md")).toBe(
          "folder/note.md",
        );
      });

      test("SHOULD allow names that start with dots", () => {
        expect(resolveVaultRelativePath("/tmp/vault", "..note.md")).toBe(
          "..note.md",
        );
      });
    });
  });

  describe("WHEN a traversal path leaves the vault", () => {
    describe("THEN it is rejected", () => {
      test("SHOULD reject parent directory traversal", () => {
        expect(() =>
          resolveVaultRelativePath("/tmp/vault", "../outside.md"),
        ).toThrow("inside the vault");
      });

      test("SHOULD reject parent directory traversal with backslashes", () => {
        expect(() =>
          resolveVaultRelativePath("/tmp/vault", "..\\outside.md"),
        ).toThrow("inside the vault");
      });
    });
  });

  describe("WHEN an absolute path leaves the vault", () => {
    describe("THEN it is rejected", () => {
      test("SHOULD reject outside absolute paths", () => {
        expect(() =>
          resolveVaultRelativePath("/tmp/vault", "/tmp/outside.md"),
        ).toThrow("inside the vault");
      });
    });
  });
});

describe("GIVEN SQLite search database initialization", () => {
  describe("WHEN initializing a new database", () => {
    describe("THEN schema and metadata are created", () => {
      test("SHOULD create the expected tables and status", async () => {
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
          sqlite: {
            ok: true,
            walEnabled: true,
            foreignKeysEnabled: true,
          },
        });

        const database = new Database(databasePath, { readonly: true });
        try {
          expect(readTableNames(database)).toEqual(
            expect.arrayContaining(["index_metadata", "notes", "chunks"]),
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
      test("SHOULD preserve existing metadata and counts", async () => {
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
      test("SHOULD fail before reporting healthy status", async () => {
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
      test("SHOULD fail before reporting healthy status", async () => {
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
      test("SHOULD not stamp missing metadata onto the database", async () => {
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

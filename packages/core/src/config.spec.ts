import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigServiceError,
  defaultArchiveFolder,
  defaultArchiveOnRemove,
  defaultIgnoredPaths,
  defaultSearchLimit,
  getDefaultConfigPath,
  loadConfig,
  resolveVaultRelativePath,
} from "./config.js";

describe("GIVEN Vaultgentic config loading", () => {
  describe("WHEN loading a valid explicit config path", () => {
    describe("THEN paths are resolved and ignored paths are merged", () => {
      it("SHOULD return a resolved minimal config", async () => {
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
          ignoredPaths: [
            ...defaultIgnoredPaths.filter(
              (ignoredPath) => ignoredPath !== defaultArchiveFolder,
            ),
            "archive",
            defaultArchiveFolder,
          ],
          searchLimit: defaultSearchLimit,
          archiveOnRemove: defaultArchiveOnRemove,
          archiveFolder: defaultArchiveFolder,
        });
      });

      it("SHOULD preserve ignored path patterns for scanner matching", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-config-"));
        await mkdir(path.join(cwd, "vault"));
        const configPath = path.join(cwd, "custom-config.json");
        await writeFile(
          configPath,
          JSON.stringify({
            vaultPath: "vault",
            databasePath: ".vaultgentic/index.sqlite",
            ignoredPaths: ["**/node_modules/**", "\\!important.md"],
          }),
        );

        await expect(loadConfig({ configPath, cwd })).resolves.toMatchObject({
          ignoredPaths: [
            ...defaultIgnoredPaths.filter(
              (ignoredPath) => ignoredPath !== defaultArchiveFolder,
            ),
            "**/node_modules/**",
            "\\!important.md",
            defaultArchiveFolder,
          ],
        });
      });

      it("SHOULD return a configured search limit", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-config-"));
        const configPath = path.join(cwd, "custom-config.json");
        await writeFile(
          configPath,
          JSON.stringify({
            vaultPath: "vault",
            databasePath: ".vaultgentic/index.sqlite",
            searchLimit: 3,
          }),
        );

        await expect(loadConfig({ configPath, cwd })).resolves.toMatchObject({
          searchLimit: 3,
        });
      });

      it("SHOULD return configured archive remove settings", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-config-"));
        const configPath = path.join(cwd, "custom-config.json");
        await writeFile(
          configPath,
          JSON.stringify({
            vaultPath: "vault",
            databasePath: ".vaultgentic/index.sqlite",
            archiveOnRemove: false,
            archiveFolder: "Deleted Notes",
          }),
        );

        await expect(loadConfig({ configPath, cwd })).resolves.toMatchObject({
          archiveOnRemove: false,
          archiveFolder: "Deleted Notes",
        });
      });

      it("SHOULD ignore a configured archive folder when archive removes are enabled", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-config-"));
        const configPath = path.join(cwd, "custom-config.json");
        await writeFile(
          configPath,
          JSON.stringify({
            vaultPath: "vault",
            databasePath: ".vaultgentic/index.sqlite",
            archiveFolder: "Deleted Notes",
          }),
        );

        await expect(loadConfig({ configPath, cwd })).resolves.toMatchObject({
          ignoredPaths: [...defaultIgnoredPaths, "Deleted Notes"],
        });
      });

      it("SHOULD keep the archive folder ignore after configured ignore paths", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-config-"));
        const configPath = path.join(cwd, "custom-config.json");
        await writeFile(
          configPath,
          JSON.stringify({
            vaultPath: "vault",
            databasePath: ".vaultgentic/index.sqlite",
            archiveFolder: "Deleted Notes",
            ignoredPaths: ["!Deleted Notes/keep.md"],
          }),
        );

        await expect(loadConfig({ configPath, cwd })).resolves.toMatchObject({
          ignoredPaths: [
            ...defaultIgnoredPaths,
            "!Deleted Notes/keep.md",
            "Deleted Notes",
          ],
        });
      });
    });
  });

  describe("WHEN loading from the default config location", () => {
    describe("THEN the OS config directory is used", () => {
      it("SHOULD load config.json from XDG_CONFIG_HOME on Linux", async () => {
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
      it("SHOULD use ~/.config/vaultgentic/config.json on Linux", () => {
        expect(
          getDefaultConfigPath({
            platform: "linux",
            env: {},
            homeDirectory: "/home/example",
          }),
        ).toBe("/home/example/.config/vaultgentic/config.json");
      });

      it("SHOULD use XDG_CONFIG_HOME on Linux when set", () => {
        expect(
          getDefaultConfigPath({
            platform: "linux",
            env: { XDG_CONFIG_HOME: "/custom/config" },
            homeDirectory: "/home/example",
          }),
        ).toBe("/custom/config/vaultgentic/config.json");
      });

      it("SHOULD use APPDATA on Windows when set", () => {
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
      it("SHOULD load the environment-selected config", async () => {
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
      it("SHOULD include the missing config path", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-missing-config-"),
        );
        const configPath = path.join(cwd, "missing-config.json");

        await expect(loadConfig({ configPath, cwd })).rejects.toThrow(
          configPath,
        );
        await expect(loadConfig({ configPath, cwd })).rejects.toBeInstanceOf(
          ConfigServiceError,
        );
      });
    });
  });

  describe("WHEN the config JSON is invalid", () => {
    describe("THEN a clear error is thrown", () => {
      it("SHOULD explain that JSON parsing failed", async () => {
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
      it("SHOULD require vaultPath", async () => {
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

      it("SHOULD require databasePath", async () => {
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

  describe("WHEN search limit config is invalid", () => {
    describe("THEN clear validation errors are thrown", () => {
      it.each([1.5, 0, -1, 101])(
        "SHOULD reject %s as a search limit",
        async (searchLimit) => {
          const cwd = await mkdtemp(
            path.join(tmpdir(), "vaultgentic-invalid-search-limit-"),
          );
          await writeFile(
            path.join(cwd, "config.json"),
            JSON.stringify({
              vaultPath: "vault",
              databasePath: "db.sqlite",
              searchLimit,
            }),
          );

          await expect(
            loadConfig({ configPath: "config.json", cwd }),
          ).rejects.toThrow("searchLimit");
        },
      );
    });
  });

  describe("WHEN archive folder config is invalid", () => {
    describe("THEN clear validation errors are thrown", () => {
      it.each(["../outside", "/tmp/archive"])(
        "SHOULD reject %s as an archive folder",
        async (archiveFolder) => {
          const cwd = await mkdtemp(
            path.join(tmpdir(), "vaultgentic-invalid-archive-folder-"),
          );
          await writeFile(
            path.join(cwd, "config.json"),
            JSON.stringify({
              vaultPath: "vault",
              databasePath: "db.sqlite",
              archiveFolder,
            }),
          );

          await expect(
            loadConfig({ configPath: "config.json", cwd }),
          ).rejects.toThrow("Archive folder");
        },
      );
    });
  });
});

describe("GIVEN vault-relative path resolution", () => {
  describe("WHEN a path stays inside the vault", () => {
    describe("THEN it is returned as a public vault-relative path", () => {
      it("SHOULD normalize nested paths", () => {
        expect(resolveVaultRelativePath("/tmp/vault", "folder/note.md")).toBe(
          "folder/note.md",
        );
      });

      it("SHOULD normalize backslash separators", () => {
        expect(resolveVaultRelativePath("/tmp/vault", "folder\\note.md")).toBe(
          "folder/note.md",
        );
      });

      it("SHOULD allow names that start with dots", () => {
        expect(resolveVaultRelativePath("/tmp/vault", "..note.md")).toBe(
          "..note.md",
        );
      });
    });
  });

  describe("WHEN a traversal path leaves the vault", () => {
    describe("THEN it is rejected", () => {
      it("SHOULD reject parent directory traversal", () => {
        expect(() =>
          resolveVaultRelativePath("/tmp/vault", "../outside.md"),
        ).toThrow(ConfigServiceError);
      });

      it("SHOULD reject parent directory traversal with backslashes", () => {
        expect(() =>
          resolveVaultRelativePath("/tmp/vault", "..\\outside.md"),
        ).toThrow("inside the vault");
      });
    });
  });

  describe("WHEN an absolute path leaves the vault", () => {
    describe("THEN it is rejected", () => {
      it("SHOULD reject outside absolute paths", () => {
        expect(() =>
          resolveVaultRelativePath("/tmp/vault", "/tmp/outside.md"),
        ).toThrow("inside the vault");
      });
    });
  });
});

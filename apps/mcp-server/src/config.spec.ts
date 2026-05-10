import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpServerConfig } from "./config.js";

describe("GIVEN MCP server config bootstrap", () => {
  describe("WHEN loading startup config", () => {
    describe("THEN config files are preferred and env vault bootstrap is supported", () => {
      it("SHOULD bootstrap from the MCP vault path environment variable", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        await mkdir(vaultPath);

        const config = await loadMcpServerConfig({
          cwd,
          env: { VAULTGENTIC_VAULT_PATH: vaultPath },
        });

        expect(config).toMatchObject({
          vaultPath,
          databasePath: path.join(vaultPath, ".vaultgentic", "index.sqlite"),
          searchLimit: 5,
        });
        expect(config.ignoredPaths).toContain(".vaultgentic");
      });

      it("SHOULD prefer explicit config over the MCP vault path environment variable", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const configVaultPath = path.join(cwd, "config-vault");
        const envVaultPath = path.join(cwd, "env-vault");
        const databasePath = path.join(cwd, "configured.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(configVaultPath);
        await mkdir(envVaultPath);
        await writeFile(
          configPath,
          JSON.stringify({
            vaultPath: configVaultPath,
            databasePath,
          }),
        );

        const config = await loadMcpServerConfig({
          configPath,
          env: { VAULTGENTIC_VAULT_PATH: envVaultPath },
        });

        expect(config.vaultPath).toBe(configVaultPath);
        expect(config.databasePath).toBe(databasePath);
      });

      it("SHOULD fail clearly when config and MCP vault path are missing", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));

        await expect(loadMcpServerConfig({ cwd, env: {} })).rejects.toThrow(
          "MCP server requires a config file or VAULTGENTIC_VAULT_PATH",
        );
      });

      it("SHOULD NOT hide invalid explicit config errors", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const configPath = path.join(cwd, "config.json");
        await writeFile(configPath, "{}");

        await expect(
          loadMcpServerConfig({
            configPath,
            env: { VAULTGENTIC_VAULT_PATH: path.join(cwd, "vault") },
          }),
        ).rejects.toThrow("Invalid config");
      });
    });
  });
});

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createVaultgenticMcpServer,
  forbiddenMcpToolNameParts,
  mcpServerPackageName,
  mcpToolPrefix,
  plannedMcpToolNames,
  readToolInputSchema,
  searchToolInputSchema,
  sharedCorePackageName,
} from "./index.js";

describe("GIVEN the MCP server skeleton", () => {
  describe("WHEN creating the server from shared config", () => {
    describe("THEN startup uses core services without exposing indexing tools", () => {
      it("SHOULD create a named MCP server and initialize the database", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({
            vaultPath,
            databasePath,
          }),
        );

        const mcpServer = await createVaultgenticMcpServer({ configPath });

        expect(sharedCorePackageName).toBe("vaultgentic-core");
        expect(mcpServerPackageName).toBe("vaultgentic-mcp-server");
        expect(mcpServer.config).toMatchObject({ vaultPath, databasePath });
        expect(mcpServer.databaseStatus.databasePath).toBe(databasePath);
        expect(mcpServer.server).toBeDefined();
      });

      it("SHOULD reserve only vaultgentic-prefixed search and read tool names", () => {
        expect(plannedMcpToolNames).toEqual([
          "vaultgentic_search",
          "vaultgentic_read",
        ]);
        expect(
          plannedMcpToolNames.every((name) => name.startsWith(mcpToolPrefix)),
        ).toBe(true);
      });

      it("SHOULD define future tool inputs with Zod", () => {
        expect(
          searchToolInputSchema.safeParse({ query: "local search", limit: 3 })
            .success,
        ).toBe(true);
        expect(
          readToolInputSchema.safeParse({ target: "note.md" }).success,
        ).toBe(true);
      });

      it("SHOULD NOT expose sync, file, rebuild, watch, or index tools", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({
            vaultPath,
            databasePath,
          }),
        );

        const mcpServer = await createVaultgenticMcpServer({ configPath });

        expect(mcpServer.toolNames).toEqual([]);
        for (const forbiddenNamePart of forbiddenMcpToolNameParts) {
          expect(
            mcpServer.toolNames.some((toolName) =>
              toolName.includes(forbiddenNamePart),
            ),
          ).toBe(false);
        }
      });
    });
  });
});

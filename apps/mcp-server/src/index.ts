#!/usr/bin/env node
import {
  initializeSearchDatabase,
  loadConfig,
  vaultgenticCoreName,
  type DatabaseStatus,
} from "@vaultgentic/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";

type McpServerConfig = Awaited<ReturnType<typeof loadConfig>>;

type VaultgenticMcpServer = {
  config: McpServerConfig;
  databaseStatus: DatabaseStatus;
  server: McpServer;
  toolNames: string[];
};

type CreateVaultgenticMcpServerOptions = {
  configPath?: string;
};

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export const mcpServerPackageName = "vaultgentic-mcp-server";
export const mcpToolPrefix = "vaultgentic_";
export const plannedMcpToolNames = [
  "vaultgentic_search",
  "vaultgentic_read",
] as const;
export const searchToolInputSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(100).optional(),
});
export const readToolInputSchema = z.object({
  target: z.string().trim().min(1),
});
export const forbiddenMcpToolNameParts = [
  "sync",
  "file",
  "rebuild",
  "watch",
  "index",
] as const;
export const sharedCorePackageName = vaultgenticCoreName;
export const packageVersion = packageJson.version;

export function isMainModule(
  moduleUrl: string,
  argvPath: string | undefined,
): boolean {
  if (argvPath === undefined) {
    return false;
  }

  return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
}

export async function createVaultgenticMcpServer(
  options: CreateVaultgenticMcpServerOptions = {},
): Promise<VaultgenticMcpServer> {
  const config = await loadConfig({ configPath: options.configPath });
  const databaseStatus = initializeSearchDatabase(config);
  const server = new McpServer({
    name: mcpServerPackageName,
    version: packageVersion,
  });

  return {
    config,
    databaseStatus,
    server,
    toolNames: [],
  };
}

export async function startVaultgenticMcpServer(
  options: CreateVaultgenticMcpServerOptions = {},
): Promise<void> {
  const { server } = await createVaultgenticMcpServer(options);
  await server.connect(new StdioServerTransport());
}

export async function runMcpServerMain(
  options: CreateVaultgenticMcpServerOptions & {
    errorStream?: Pick<NodeJS.WriteStream, "write">;
    exit?: (code: number) => never;
  } = {},
): Promise<void> {
  try {
    await startVaultgenticMcpServer({ configPath: options.configPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorStream = options.errorStream ?? process.stderr;
    errorStream.write(`vaultgentic MCP server failed to start: ${message}\n`);
    const exit = options.exit ?? process.exit;
    exit(1);
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await runMcpServerMain();
}

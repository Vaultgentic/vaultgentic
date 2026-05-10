#!/usr/bin/env node
import {
  initializeSearchDatabase,
  refreshSearchIndex,
  vaultgenticCoreName,
  type DatabaseStatus,
  type RefreshSearchIndexResult,
  type SearchDatabaseConfig,
} from "@vaultgentic/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadMcpServerConfig } from "./config.js";

type McpServerConfig = Awaited<ReturnType<typeof loadMcpServerConfig>>;

type VaultgenticMcpServer = {
  config: McpServerConfig;
  databaseStatus: DatabaseStatus;
  ensureIndexFresh: () => Promise<RefreshSearchIndexResult>;
  server: McpServer;
  toolNames: string[];
};

type CreateVaultgenticMcpServerOptions = {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  refreshIndex?: (
    config: SearchDatabaseConfig,
  ) => Promise<RefreshSearchIndexResult>;
  refreshThrottleMs?: number;
};

type McpIndexRefreshCoordinator = {
  ensureIndexFresh: () => Promise<RefreshSearchIndexResult>;
};

type CreateMcpIndexRefreshCoordinatorOptions = {
  now?: () => number;
  refreshIndex?: (
    config: SearchDatabaseConfig,
  ) => Promise<RefreshSearchIndexResult>;
  throttleMs?: number;
};

const defaultRefreshThrottleMs = 5_000;

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

export function createMcpIndexRefreshCoordinator(
  config: SearchDatabaseConfig,
  options: CreateMcpIndexRefreshCoordinatorOptions = {},
): McpIndexRefreshCoordinator {
  const now = options.now ?? Date.now;
  const refreshIndex = options.refreshIndex ?? refreshSearchIndex;
  const throttleMs = options.throttleMs ?? defaultRefreshThrottleMs;
  let inFlightRefresh: Promise<RefreshSearchIndexResult> | undefined;
  let lastRefreshFinishedAt = 0;

  return {
    async ensureIndexFresh() {
      if (inFlightRefresh !== undefined) {
        return inFlightRefresh;
      }

      if (
        lastRefreshFinishedAt > 0 &&
        now() - lastRefreshFinishedAt < throttleMs
      ) {
        return {
          sync: {
            indexed: 0,
            skipped: 0,
            deleted: 0,
            files: [],
            deletedPaths: [],
          },
          status: initializeSearchDatabase(config),
        };
      }

      inFlightRefresh = refreshIndex(config);
      try {
        const result = await inFlightRefresh;
        lastRefreshFinishedAt = now();
        return result;
      } finally {
        inFlightRefresh = undefined;
      }
    },
  };
}

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
  const config = await loadMcpServerConfig({
    configPath: options.configPath,
    cwd: options.cwd,
    env: options.env,
  });
  initializeSearchDatabase(config);
  const refreshCoordinator = createMcpIndexRefreshCoordinator(config, {
    refreshIndex: options.refreshIndex,
    throttleMs: options.refreshThrottleMs,
  });
  const refreshResult = await refreshCoordinator.ensureIndexFresh();
  const server = new McpServer({
    name: mcpServerPackageName,
    version: packageVersion,
  });

  return {
    config,
    databaseStatus: refreshResult.status,
    ensureIndexFresh: refreshCoordinator.ensureIndexFresh,
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
    await startVaultgenticMcpServer(options);
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

#!/usr/bin/env node
import {
  defaultArchiveFolder,
  defaultArchiveOnRemove,
  initializeSearchDatabase,
  patchVaultNote,
  readVaultTarget,
  removeVaultNote,
  searchVault,
  writeVaultNote,
} from "@vaultgentic/core";
import type {
  DatabaseStatus,
  RefreshSearchIndexResult,
  SearchDatabaseConfig,
} from "@vaultgentic/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadMcpServerConfig } from "./config.js";
import {
  forbiddenMcpToolNameParts,
  mcpToolPrefix,
  plannedMcpToolNames,
  sharedCorePackageName,
  toMcpToolError,
} from "./tools/shared.js";
import {
  createPatchToolHandler,
  patchToolInputSchema,
  type PatchToolInput,
  type PatchToolResponse,
} from "./tools/patch.js";
import {
  createRemoveToolHandler,
  removeToolInputSchema,
  type RemoveToolInput,
  type RemoveToolResponse,
} from "./tools/remove.js";
import {
  createReadToolHandler,
  readToolInputSchema,
  type ReadToolInput,
  type ReadToolResponse,
} from "./tools/read.js";
import {
  createWriteToolHandler,
  writeToolInputSchema,
  type WriteToolInput,
  type WriteToolResponse,
} from "./tools/write.js";
import { createMcpIndexRefreshCoordinator } from "./refresh.js";
import {
  createSearchToolHandler,
  searchToolInputSchema,
  type SearchToolInput,
  type SearchToolResponse,
} from "./tools/search.js";

export {
  createMcpIndexRefreshCoordinator,
  forbiddenMcpToolNameParts,
  mcpToolPrefix,
  patchToolInputSchema,
  plannedMcpToolNames,
  readToolInputSchema,
  removeToolInputSchema,
  searchToolInputSchema,
  sharedCorePackageName,
  writeToolInputSchema,
};

type VaultgenticMcpServer = {
  config: Awaited<ReturnType<typeof loadMcpServerConfig>>;
  databaseStatus: DatabaseStatus;
  ensureIndexFresh: () => Promise<RefreshSearchIndexResult>;
  patch: (input: PatchToolInput) => Promise<PatchToolResponse>;
  read: (input: ReadToolInput) => Promise<ReadToolResponse>;
  remove: (input: RemoveToolInput) => Promise<RemoveToolResponse>;
  server: McpServer;
  search: (input: SearchToolInput) => Promise<SearchToolResponse>;
  toolNames: string[];
  write: (input: WriteToolInput) => Promise<WriteToolResponse>;
};

type CreateVaultgenticMcpServerOptions = {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  refreshIndex?: (
    config: SearchDatabaseConfig,
  ) => Promise<RefreshSearchIndexResult>;
  patch?: typeof patchVaultNote;
  read?: typeof readVaultTarget;
  refreshThrottleMs?: number;
  remove?: typeof removeVaultNote;
  search?: typeof searchVault;
  write?: typeof writeVaultNote;
};

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export const mcpServerPackageName = "vaultgentic-mcp-server";
export const packageVersion = packageJson.version;

const searchToolDescription =
  "Search indexed vault notes. Requires query. Default mode is hybrid; title matches note titles, paths, and aliases. Omit filter for unscoped search. Use filter.kind='scope' with scope for a directory prefix, filter.kind='path' with path for one exact note path, or filter.kind='tags' with tags for frontmatter tags only. Never pass empty strings. For note-name lookup, try title mode once; if no result, broaden to hybrid or keyword. Returns compact JSON with paths, titles, ranks, snippets, warnings, index status, and refresh summary.";

const readToolDescription =
  "Read a vault note by vault-relative .md path or an indexed numeric chunk id. Read before patching removing or overwriting when you need current content or a file hash. Set includeMetadata=true on note reads to return metadata and fileHash. includeNoteContext only affects chunk reads. maxChars truncates returned content safely.";

const writeToolDescription =
  "Create or replace a vault note at a vault-relative .md path. This is a whole-note replacement; read first when preserving existing content frontmatter or links matters. body excludes frontmatter; optional frontmatter tags and aliases are serialized into the note. Returns metadata only and does not echo note content.";

const patchToolDescription =
  "Apply an opencode-style patch to one existing vault note. Patch text must use *** Begin Patch, exactly one *** Update File: <path> matching the tool path, one or more @@ chunks, context lines prefixed by space, removals with -, additions with +, and *** End Patch. Add File, Delete File, Move to, multi-operation patches, and path mismatches are unsupported. Read the note first to get exact content and fileHash, then pass expectedFileHash for concurrency safety. On hash mismatch re-read and regenerate the patch from fresh content. Returns metadata only and does not echo patch or note content.";

function createRemoveToolDescription(
  config: Awaited<ReturnType<typeof loadMcpServerConfig>>,
): string {
  const archiveOnRemove = config.archiveOnRemove ?? defaultArchiveOnRemove;
  const removeBehavior = archiveOnRemove
    ? `Configured to archive removed notes under ${config.archiveFolder ?? defaultArchiveFolder}.`
    : "Configured to permanently delete removed notes.";

  return `Remove a vault note by vault-relative .md path. Read first and pass expectedFileHash to prevent stale concurrent deletion. ${removeBehavior} Returns metadata only and does not echo note content.`;
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
  const search = createSearchToolHandler({
    config,
    ensureIndexFresh: refreshCoordinator.ensureIndexFresh,
    search: options.search ?? searchVault,
  });
  const read = createReadToolHandler({
    config,
    ensureIndexFresh: refreshCoordinator.ensureIndexFresh,
    read: options.read ?? readVaultTarget,
  });
  const write = createWriteToolHandler({
    config,
    write: options.write ?? writeVaultNote,
  });
  const patch = createPatchToolHandler({
    config,
    patch: options.patch ?? patchVaultNote,
  });
  const remove = createRemoveToolHandler({
    config,
    remove: options.remove ?? removeVaultNote,
  });

  server.registerTool(
    "vaultgentic_search",
    {
      description: searchToolDescription,
      inputSchema: searchToolInputSchema,
    },
    async (input) => toMcpToolResult(search(input)),
  );
  server.tool(
    "vaultgentic_read",
    readToolDescription,
    readToolInputSchema.shape,
    async (input) => toMcpToolResult(read(input)),
  );
  server.tool(
    "vaultgentic_write",
    writeToolDescription,
    writeToolInputSchema.shape,
    async (input) => toMcpToolResult(write(input)),
  );
  server.tool(
    "vaultgentic_patch",
    patchToolDescription,
    patchToolInputSchema.shape,
    async (input) => toMcpToolResult(patch(input)),
  );
  server.tool(
    "vaultgentic_remove",
    createRemoveToolDescription(config),
    removeToolInputSchema.shape,
    async (input) => toMcpToolResult(remove(input)),
  );

  return {
    config,
    databaseStatus: refreshResult.status,
    ensureIndexFresh: refreshCoordinator.ensureIndexFresh,
    patch,
    read,
    remove,
    search,
    server,
    toolNames: [...plannedMcpToolNames],
    write,
  };
}

async function toMcpToolResult(result: Promise<unknown>) {
  try {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(await result, null, 2) },
      ],
    };
  } catch (error) {
    const toolError = toMcpToolError(error);
    return {
      isError: true,
      structuredContent: toolError.details,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(toolError.details, null, 2),
        },
      ],
    };
  }
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

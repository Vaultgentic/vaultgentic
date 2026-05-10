import {
  ConfigServiceError,
  defaultIgnoredPaths,
  defaultSearchLimit,
  loadConfig,
  resolveVaultPath,
} from "@vaultgentic/core";
import path from "node:path";
import { z } from "zod";

type McpServerConfig = Awaited<ReturnType<typeof loadConfig>>;

type LoadMcpServerConfigOptions = {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const mcpBootstrapEnvSchema = z.object({
  VAULTGENTIC_CONFIG: z.string().trim().min(1).optional(),
  VAULTGENTIC_VAULT_PATH: z.string().trim().min(1).optional(),
});

export async function loadMcpServerConfig(
  options: LoadMcpServerConfigOptions = {},
): Promise<McpServerConfig> {
  const env = parseMcpBootstrapEnv(options.env ?? process.env);
  const configPath = options.configPath ?? env.VAULTGENTIC_CONFIG;
  const hasConfiguredPath = configPath !== undefined;

  if (hasConfiguredPath || options.env === undefined) {
    try {
      return await loadConfig({ configPath, cwd: options.cwd });
    } catch (error) {
      if (
        hasConfiguredPath ||
        env.VAULTGENTIC_VAULT_PATH === undefined ||
        !isMissingDefaultConfigFile(error)
      ) {
        throw error;
      }
    }
  }

  if (env.VAULTGENTIC_VAULT_PATH === undefined) {
    throw new ConfigServiceError(
      "MCP server requires a config file or VAULTGENTIC_VAULT_PATH",
    );
  }

  const vaultPath = resolveVaultPath(env.VAULTGENTIC_VAULT_PATH, {
    cwd: options.cwd,
  });

  return {
    vaultPath,
    databasePath: path.join(vaultPath, ".vaultgentic", "index.sqlite"),
    ignoredPaths: defaultIgnoredPaths,
    searchLimit: defaultSearchLimit,
  };
}

function parseMcpBootstrapEnv(
  env: NodeJS.ProcessEnv,
): z.infer<typeof mcpBootstrapEnvSchema> {
  return mcpBootstrapEnvSchema.parse({
    VAULTGENTIC_CONFIG: env.VAULTGENTIC_CONFIG,
    VAULTGENTIC_VAULT_PATH: env.VAULTGENTIC_VAULT_PATH,
  });
}

function isMissingDefaultConfigFile(error: unknown): boolean {
  if (
    !(error instanceof ConfigServiceError) ||
    !error.message.startsWith("Could not read config")
  ) {
    return false;
  }

  return getErrorCode(error.cause) === "ENOENT";
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

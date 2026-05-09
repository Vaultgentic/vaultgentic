import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { VaultgenticError } from "./errors.js";

export const defaultIgnoredPaths = [
  ".obsidian",
  ".trash",
  "node_modules",
  ".git",
  ".vaultgentic",
];

export const configDirectoryName = "vaultgentic";
export const configFileName = "config.json";

export class ConfigServiceError extends VaultgenticError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigServiceError";
  }
}

const configSchema = z.object({
  vaultPath: z.string().trim().min(1),
  databasePath: z.string().trim().min(1),
  ignoredPaths: z.array(z.string()).optional(),
});

export async function loadConfig(
  options: { configPath?: string; cwd?: string } = {},
): Promise<{
  vaultPath: string;
  databasePath: string;
  ignoredPaths: string[];
}> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath(options.configPath, cwd);
  let configText: string;

  try {
    configText = await readFile(configPath, "utf8");
  } catch (error) {
    throw new ConfigServiceError(
      `Could not read config at ${configPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let config: unknown;
  try {
    config = JSON.parse(configText);
  } catch (error) {
    throw new ConfigServiceError(
      `Invalid config JSON at ${configPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const parseResult = configSchema.safeParse(config);
  if (!parseResult.success) {
    throw new ConfigServiceError(
      `Invalid config at ${configPath}: ${z.prettifyError(parseResult.error)}`,
      { cause: parseResult.error },
    );
  }

  const parsedConfig = parseResult.data;
  const vaultPath = resolveVaultPath(parsedConfig.vaultPath, { cwd });
  const databasePath = path.resolve(cwd, parsedConfig.databasePath);
  const ignoredPaths = mergeIgnoredPaths(
    vaultPath,
    parsedConfig.ignoredPaths ?? [],
  );

  return { vaultPath, databasePath, ignoredPaths };
}

export function resolveVaultPath(
  vaultPath: string,
  options: { cwd?: string } = {},
): string {
  if (typeof vaultPath !== "string" || vaultPath.trim() === "") {
    throw new ConfigServiceError("Vault path must be a non-empty string");
  }

  return path.resolve(options.cwd ?? process.cwd(), vaultPath);
}

export function resolveVaultRelativePath(
  vaultPath: string,
  candidatePath: string,
): string {
  if (typeof candidatePath !== "string" || candidatePath.trim() === "") {
    throw new ConfigServiceError(
      "Vault-relative path must be a non-empty string",
    );
  }

  const normalizedCandidatePath = candidatePath.replaceAll("\\", "/");
  const resolvedVaultPath = path.resolve(vaultPath);
  const resolvedCandidatePath = path.resolve(
    resolvedVaultPath,
    normalizedCandidatePath,
  );
  const relativePath = path.relative(resolvedVaultPath, resolvedCandidatePath);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new ConfigServiceError(
      `Path must stay inside the vault: ${candidatePath}`,
    );
  }

  return toPublicPath(relativePath);
}

export function getDefaultConfigPath(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();

  if (platform === "win32") {
    const configRoot =
      env.APPDATA ?? path.win32.join(homeDirectory, "AppData", "Roaming");
    return path.win32.join(configRoot, configDirectoryName, configFileName);
  }

  const configRoot =
    env.XDG_CONFIG_HOME ?? path.posix.join(homeDirectory, ".config");
  return path.posix.join(configRoot, configDirectoryName, configFileName);
}

function resolveConfigPath(
  configPath: string | undefined,
  cwd: string,
): string {
  const selectedPath = configPath ?? process.env.VAULTGENTIC_CONFIG;

  if (selectedPath !== undefined) {
    return path.resolve(cwd, selectedPath);
  }

  return getDefaultConfigPath();
}

function mergeIgnoredPaths(
  vaultPath: string,
  configuredPaths: string[],
): string[] {
  return [
    ...new Set(
      [...defaultIgnoredPaths, ...configuredPaths].map((entry) =>
        resolveVaultRelativePath(vaultPath, entry),
      ),
    ),
  ];
}

function toPublicPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

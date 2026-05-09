export const vaultgenticCoreName = "vaultgentic-core";

export {
  initializeSearchDatabase,
  schemaVersion,
  type DatabaseStatus,
  type SearchDatabaseConfig,
} from "./database.js";

export {
  configDirectoryName,
  configFileName,
  defaultIgnoredPaths,
  getDefaultConfigPath,
  loadConfig,
  resolveVaultPath,
  resolveVaultRelativePath,
} from "./config.js";

export {
  scanVaultFiles,
  type VaultFileMetadata,
  type VaultScanConfig,
} from "./scanner.js";

export {
  parseMarkdownNote,
  type MarkdownHeading,
  type ParsedMarkdownNote,
  type WikiLink,
} from "./markdown.js";

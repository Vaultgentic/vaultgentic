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
  chunkMarkdownNote,
  parseMarkdownNote,
  type MarkdownChunk,
  type MarkdownHeading,
  type ParsedMarkdownNote,
  type WikiLink,
} from "./markdown.js";

export {
  indexVaultFile,
  openSearchDatabase,
  rebuildSearchIndex,
  searchBm25,
  searchTitles,
  syncSearchIndex,
  type Bm25SearchResult,
  type IndexFileResult,
  type RebuildSearchIndexResult,
  type SyncSearchIndexResult,
  type TitleSearchResult,
} from "./indexer.js";

export {
  readVaultTarget,
  type NoteMetadata,
  type ReadVaultChunkResult,
  type ReadVaultNoteResult,
  type ReadVaultTargetOptions,
  type ReadVaultTargetResult,
} from "./read.js";

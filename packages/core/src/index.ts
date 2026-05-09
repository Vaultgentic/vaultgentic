export const vaultgenticCoreName = "vaultgentic-core";

export {
  initializeSearchDatabase,
  SearchDatabaseError,
  schemaVersion,
  type DatabaseStatus,
  type SearchDatabaseConfig,
} from "./database.js";

export {
  configDirectoryName,
  configFileName,
  ConfigServiceError,
  defaultIgnoredPaths,
  getDefaultConfigPath,
  loadConfig,
  resolveVaultPath,
  resolveVaultRelativePath,
} from "./config.js";

export {
  scanVaultFiles,
  VaultScannerError,
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
  SearchIndexerError,
  searchSemantic,
  searchTitles,
  syncSearchIndex,
  type Bm25SearchResult,
  type IndexFileResult,
  type RebuildSearchIndexResult,
  type SemanticSearchResult,
  type SyncSearchIndexResult,
  type TitleSearchResult,
} from "./indexer.js";

export {
  readVaultTarget,
  VaultReadError,
  type NoteMetadata,
  type ReadVaultChunkResult,
  type ReadVaultNoteResult,
  type ReadVaultTargetOptions,
  type ReadVaultTargetResult,
} from "./read.js";

export {
  embedChunkText,
  embedQueryText,
  embedText,
  EmbeddingServiceError,
  embeddingModelMetadata,
  type EmbeddingModelMetadata,
  type EmbeddingResult,
} from "./embedding.js";

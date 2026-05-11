export const vaultgenticCoreName = "vaultgentic-core";

export { VaultgenticError } from "./errors.js";

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
  defaultSearchLimit,
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
  refreshSearchIndex,
  rebuildSearchIndex,
  readSearchFilterDiagnostics,
  searchBm25,
  SearchIndexerError,
  searchSemantic,
  searchTitles,
  syncSearchIndex,
  type Bm25SearchResult,
  type IndexFileResult,
  type IndexProgressEvent,
  type IndexProgressOptions,
  type IndexProgressPhase,
  type RebuildSearchIndexResult,
  type RefreshSearchIndexResult,
  type SearchFilterDiagnostics,
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
  writeVaultNote,
  VaultWriteError,
  type WriteVaultNoteOptions,
  type WriteVaultNoteResult,
} from "./write.js";

export {
  patchVaultNote,
  VaultPatchError,
  type PatchVaultNoteOptions,
  type PatchVaultNoteResult,
} from "./patch.js";

export {
  searchVault,
  type HybridComponentName,
  type HybridComponentScore,
  type HybridSearchOutput,
  type KeywordSearchOutput,
  type SearchMode,
  type SearchOutput,
  type SemanticSearchOutput,
  type TitleSearchOutput,
} from "./search.js";

export {
  embedChunkText,
  embedQueryText,
  embedText,
  EmbeddingServiceError,
  embeddingModelMetadata,
  type EmbeddingModelMetadata,
  type EmbeddingResult,
} from "./embedding.js";

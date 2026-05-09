import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { defaultIgnoredPaths, resolveVaultRelativePath } from "./config.js";

export type VaultFileMetadata = {
  path: string;
  mtime_ms: number;
  size_bytes: number;
  content_hash?: string;
};

export type VaultScanConfig = {
  vaultPath: string;
  ignoredPaths?: string[];
};

export async function scanVaultFiles(
  config: VaultScanConfig,
  options: { includeContentHash?: boolean } = {},
): Promise<VaultFileMetadata[]> {
  const vaultPath = path.resolve(config.vaultPath);
  const ignoredPaths = normalizeIgnoredPaths(
    vaultPath,
    config.ignoredPaths ?? [],
  );
  const files: VaultFileMetadata[] = [];

  await scanDirectory({
    vaultPath,
    relativeDirectoryPath: "",
    ignoredPaths,
    includeContentHash: options.includeContentHash === true,
    files,
  });

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function scanDirectory(options: {
  vaultPath: string;
  relativeDirectoryPath: string;
  ignoredPaths: string[];
  includeContentHash: boolean;
  files: VaultFileMetadata[];
}): Promise<void> {
  const directoryPath = toAbsolutePath(
    options.vaultPath,
    options.relativeDirectoryPath,
  );
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    const relativePath = resolveScannedRelativePath(
      options.vaultPath,
      absolutePath,
    );

    if (isIgnored(relativePath, options.ignoredPaths)) {
      continue;
    }

    if (entry.isDirectory()) {
      await scanDirectory({ ...options, relativeDirectoryPath: relativePath });
      continue;
    }

    if (!entry.isFile() || !relativePath.endsWith(".md")) {
      continue;
    }

    const fileStat = await stat(absolutePath);
    const metadata: VaultFileMetadata = {
      path: relativePath,
      mtime_ms: Math.trunc(fileStat.mtimeMs),
      size_bytes: fileStat.size,
    };

    if (options.includeContentHash) {
      metadata.content_hash = createHash("sha256")
        .update(await readFile(absolutePath))
        .digest("hex");
    }

    options.files.push(metadata);
  }
}

function normalizeIgnoredPaths(
  vaultPath: string,
  configuredIgnoredPaths: string[],
): string[] {
  return [
    ...new Set(
      [...defaultIgnoredPaths, ...configuredIgnoredPaths].flatMap(
        (ignoredPath) => normalizeIgnoredPath(vaultPath, ignoredPath),
      ),
    ),
  ];
}

function normalizeIgnoredPath(
  vaultPath: string,
  ignoredPath: string,
): string[] {
  return [
    resolveVaultRelativePath(vaultPath, ignoredPath),
    resolveScannedRelativePath(vaultPath, path.resolve(vaultPath, ignoredPath)),
  ];
}

function isIgnored(relativePath: string, ignoredPaths: string[]): boolean {
  return ignoredPaths.some(
    (ignoredPath) =>
      relativePath === ignoredPath ||
      relativePath.startsWith(`${ignoredPath}/`),
  );
}

function toAbsolutePath(vaultPath: string, relativePath: string): string {
  return relativePath === ""
    ? vaultPath
    : path.join(vaultPath, ...relativePath.split("/"));
}

function resolveScannedRelativePath(
  vaultPath: string,
  absolutePath: string,
): string {
  const relativePath = path.relative(vaultPath, absolutePath);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Path must stay inside the vault: ${absolutePath}`);
  }

  return relativePath.split(path.sep).join("/");
}

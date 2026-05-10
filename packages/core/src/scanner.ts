import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Minimatch, minimatch } from "minimatch";
import { defaultIgnoredPaths, resolveVaultRelativePath } from "./config.js";
import { VaultgenticError } from "./errors.js";

type IgnoredPath = {
  pattern: string;
  matcher: Minimatch;
  negated: boolean;
  locked: boolean;
};

const minimatchOptions = {
  dot: true,
  magicalBraces: true,
  nocomment: true,
  nonegate: true,
};

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

export class VaultScannerError extends VaultgenticError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultScannerError";
  }
}

export async function scanVaultFiles(
  config: VaultScanConfig,
  options: { includeContentHash?: boolean } = {},
): Promise<VaultFileMetadata[]> {
  const vaultPath = path.resolve(config.vaultPath);
  try {
    const includeContentHash = options.includeContentHash ?? false;
    const ignoredPaths = normalizeIgnoredPaths(
      vaultPath,
      config.ignoredPaths ?? [],
    );
    const files: VaultFileMetadata[] = [];

    await scanDirectory({
      vaultPath,
      directoryPath: vaultPath,
      ignoredPaths,
      includeContentHash,
      files,
    });

    return files.sort((left, right) => left.path.localeCompare(right.path));
  } catch (error) {
    if (error instanceof VaultScannerError) {
      throw error;
    }

    throw new VaultScannerError(
      `Failed to scan vault ${vaultPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function scanDirectory(options: {
  vaultPath: string;
  directoryPath: string;
  ignoredPaths: IgnoredPath[];
  includeContentHash: boolean;
  files: VaultFileMetadata[];
}): Promise<void> {
  const entries = await readdir(options.directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(options.directoryPath, entry.name);
    const relativePath = resolveScannedRelativePath(
      options.vaultPath,
      absolutePath,
    );

    const ignoreState = getIgnoreState(relativePath, options.ignoredPaths);
    if (
      ignoreState.ignored &&
      (!entry.isDirectory() ||
        ignoreState.locked ||
        !hasNegatedDescendant(relativePath, options.ignoredPaths))
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      await scanDirectory({ ...options, directoryPath: absolutePath });
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
): IgnoredPath[] {
  return [
    ...new Map(
      [
        ...defaultIgnoredPaths.flatMap((ignoredPath) =>
          normalizeIgnoredPath(vaultPath, ignoredPath, true),
        ),
        ...configuredIgnoredPaths.flatMap((ignoredPath) =>
          normalizeIgnoredPath(vaultPath, ignoredPath, false),
        ),
      ]
        .flatMap(expandIgnoredPattern)
        .map((ignoredPath) => [
          `${ignoredPath.locked}:${ignoredPath.negated}:${ignoredPath.pattern}`,
          ignoredPath,
        ]),
    ).values(),
  ];
}

function normalizeIgnoredPath(
  vaultPath: string,
  ignoredPath: string,
  locked: boolean,
): IgnoredPath[] {
  const escapedNegation = ignoredPath.startsWith("\\!");
  const negated = !escapedNegation && ignoredPath.startsWith("!");
  const pattern = escapedNegation
    ? ignoredPath.slice(1)
    : negated
      ? ignoredPath.slice(1)
      : ignoredPath;

  if (isGlobPattern(pattern)) {
    return [createIgnoredPath(normalizeIgnoredGlob(pattern), negated, locked)];
  }

  return normalizeLiteralIgnoredPath(vaultPath, pattern).map((literalPath) =>
    createIgnoredPath(literalPath, negated, locked),
  );
}

function normalizeLiteralIgnoredPath(
  vaultPath: string,
  ignoredPath: string,
): string[] {
  return [
    minimatch.escape(resolveVaultRelativePath(vaultPath, ignoredPath)),
    minimatch.escape(
      resolveScannedRelativePath(
        vaultPath,
        path.resolve(vaultPath, ignoredPath),
      ),
    ),
  ];
}

function expandIgnoredPattern(ignoredPath: IgnoredPath): IgnoredPath[] {
  if (ignoredPath.pattern.endsWith("/**")) {
    return [
      ignoredPath,
      createIgnoredPath(
        ignoredPath.pattern.slice(0, -3),
        ignoredPath.negated,
        ignoredPath.locked,
      ),
    ];
  }

  return [
    ignoredPath,
    createIgnoredPath(
      `${ignoredPath.pattern}/**`,
      ignoredPath.negated,
      ignoredPath.locked,
    ),
  ];
}

function createIgnoredPath(
  pattern: string,
  negated: boolean,
  locked: boolean,
): IgnoredPath {
  return {
    pattern,
    matcher: new Minimatch(pattern, minimatchOptions),
    negated,
    locked,
  };
}

function normalizeIgnoredGlob(ignoredPath: string): string {
  if (typeof ignoredPath !== "string" || ignoredPath.trim() === "") {
    throw new VaultScannerError("Ignored glob must be a non-empty string");
  }

  const pattern = ignoredPath;
  const segments = pattern.split(/[\\/]/u);

  if (
    pattern.startsWith("/") ||
    path.win32.isAbsolute(pattern) ||
    segments.includes("..")
  ) {
    throw new VaultScannerError(
      `Ignored glob must stay inside the vault: ${ignoredPath}`,
    );
  }

  return pattern;
}

function isIgnored(relativePath: string, ignoredPaths: IgnoredPath[]): boolean {
  return getIgnoreState(relativePath, ignoredPaths).ignored;
}

function getIgnoreState(
  relativePath: string,
  ignoredPaths: IgnoredPath[],
): { ignored: boolean; locked: boolean } {
  let ignored = false;
  let lockedIgnored = false;

  for (const ignoredPath of ignoredPaths) {
    if (ignoredPath.matcher.match(relativePath)) {
      if (ignoredPath.negated) {
        ignored = lockedIgnored;
        continue;
      }

      ignored = true;
      lockedIgnored = lockedIgnored || ignoredPath.locked;
    }
  }

  return { ignored, locked: lockedIgnored };
}

function hasNegatedDescendant(
  relativePath: string,
  ignoredPaths: IgnoredPath[],
): boolean {
  return ignoredPaths.some(
    (ignoredPath) =>
      ignoredPath.negated &&
      (ignoredPath.pattern === relativePath ||
        ignoredPath.pattern.startsWith(`${relativePath}/`) ||
        ignoredPath.matcher.match(relativePath, true)),
  );
}

function isGlobPattern(ignoredPath: string): boolean {
  return (
    /\\[*?[\]{}()!+@]/u.test(ignoredPath) ||
    new Minimatch(ignoredPath, minimatchOptions).hasMagic()
  );
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
    throw new VaultScannerError(
      `Path must stay inside the vault: ${absolutePath}`,
    );
  }

  return relativePath.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

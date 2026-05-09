import { CommanderError, InvalidArgumentError } from "commander";
import type { IndexProgressEvent, IndexProgressPhase } from "@vaultgentic/core";
import ora, { type Ora } from "ora";
import { createColors } from "picocolors";

type ExpectedError = Error & {
  expected: boolean;
};

type ErrorJson = {
  error: {
    name: string;
    message: string;
    expected: boolean;
    stack?: string;
    cause?: string;
  };
};

export type CliErrorFormatOptions = {
  color: boolean;
  debug: boolean;
  json: boolean;
};

export type CliProgress = {
  handle: (event: IndexProgressEvent) => void;
  succeed: (message: string) => void;
  fail: (message: string) => void;
  stop: () => void;
};

export type CliProgressOptions = {
  enabled: boolean;
  stream: Pick<NodeJS.WriteStream, "isTTY" | "write">;
};

const progressBarWidth = 10;
const progressPhaseLabels: Record<IndexProgressPhase, string> = {
  scanning: "Scanning",
  parsing: "Parsing/chunking",
  embedding: "Embedding",
  writing: "Writing",
  deleting: "Deleting",
};

export function formatCliError(
  error: unknown,
  options: CliErrorFormatOptions,
): string {
  const details = getErrorDetails(error);

  if (options.json) {
    return `${JSON.stringify(toErrorJson(details, options), null, 2)}\n`;
  }

  const colors = createColors(options.color);
  const lines = [
    `${colors.bold(colors.red("Error:"))} ${details.message}`,
    ...formatSuggestion(details.message),
  ];

  if (options.debug) {
    lines.push("", colors.bold("Debug details:"));
    lines.push(details.stack ?? `${details.name}: ${details.message}`);

    const cause = formatCause(details.cause);
    if (cause !== undefined) {
      lines.push("", colors.bold("Cause:"), cause);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function shouldUseColor(stream: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === "0") {
    return false;
  }

  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }

  return stream.isTTY === true;
}

export function createCliProgress(options: CliProgressOptions): CliProgress {
  if (!options.enabled) {
    return createNoopProgress();
  }

  if (options.stream.isTTY === true) {
    let spinner: Ora | undefined;
    return {
      handle: (event) => {
        const text = formatIndexProgressEvent(event);
        if (spinner === undefined) {
          spinner = ora({
            stream: options.stream as unknown as NodeJS.WritableStream,
          }).start(text);
          return;
        }

        spinner.text = text;
      },
      succeed: (message) => {
        spinner?.succeed(message);
        spinner = undefined;
      },
      fail: (message) => {
        spinner?.fail(message);
        spinner = undefined;
      },
      stop: () => {
        spinner?.stop();
        spinner = undefined;
      },
    };
  }

  return {
    handle: (event) => {
      options.stream.write(`${formatIndexProgressEvent(event)}\n`);
    },
    succeed: (message) => {
      options.stream.write(`${message}\n`);
    },
    fail: (message) => {
      options.stream.write(`${message}\n`);
    },
    stop: () => {},
  };
}

export function formatIndexProgressEvent(event: IndexProgressEvent): string {
  return [
    progressPhaseLabels[event.phase],
    formatProgressBar(event),
    event.path,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
}

export function isCommanderExit(error: unknown): error is CommanderError {
  return error instanceof CommanderError;
}

function createNoopProgress(): CliProgress {
  return {
    handle: () => {},
    succeed: () => {},
    fail: () => {},
    stop: () => {},
  };
}

function formatProgressBar(event: IndexProgressEvent): string | undefined {
  if (event.current === undefined || event.total === undefined) {
    return undefined;
  }

  if (event.total < 1) {
    return `[${"░".repeat(progressBarWidth)}] 0/0`;
  }

  const current = Math.min(Math.max(event.current, 0), event.total);
  const filled = Math.round((current / event.total) * progressBarWidth);
  return `[${"█".repeat(filled)}${"░".repeat(progressBarWidth - filled)}] ${current}/${event.total}`;
}

function getErrorDetails(error: unknown): {
  name: string;
  message: string;
  expected: boolean;
  stack?: string;
  cause?: unknown;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      expected: isExpectedError(error),
      stack: error.stack,
      cause: error.cause,
    };
  }

  return {
    name: "UnexpectedError",
    message: String(error),
    expected: false,
  };
}

function isExpectedError(error: Error): boolean {
  if (error instanceof InvalidArgumentError) {
    return true;
  }

  if (error instanceof CommanderError) {
    return true;
  }

  if (hasExpectedErrorField(error)) {
    return error.expected;
  }

  return false;
}

function hasExpectedErrorField(error: Error): error is ExpectedError {
  return "expected" in error && typeof error.expected === "boolean";
}

function toErrorJson(
  details: ReturnType<typeof getErrorDetails>,
  options: CliErrorFormatOptions,
): ErrorJson {
  return {
    error: {
      name: details.name,
      message: details.message,
      expected: details.expected,
      ...(options.debug && details.stack !== undefined
        ? { stack: details.stack }
        : {}),
      ...(options.debug && details.cause !== undefined
        ? { cause: formatCause(details.cause) }
        : {}),
    },
  };
}

function formatSuggestion(message: string): string[] {
  if (message.includes("use --force")) {
    return ["", "Try again with --force when running non-interactively."];
  }

  if (message.includes("Could not read config")) {
    return [
      "",
      "Pass --config <path> or create a config at the default location.",
    ];
  }

  return [];
}

function formatCause(cause: unknown): string | undefined {
  if (cause === undefined) {
    return undefined;
  }

  if (cause instanceof Error) {
    return cause.stack ?? `${cause.name}: ${cause.message}`;
  }

  return String(cause);
}

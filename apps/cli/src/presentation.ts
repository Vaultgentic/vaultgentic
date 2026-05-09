import { CommanderError, InvalidArgumentError } from "commander";
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

export function isCommanderExit(error: unknown): error is CommanderError {
  return error instanceof CommanderError;
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

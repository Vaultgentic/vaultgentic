import type { writeVaultNote, WriteVaultNoteResult } from "@vaultgentic/core";
import { z } from "zod";
import type { McpServerConfig } from "../types.js";
import { toMcpToolError } from "./shared.js";

export type WriteToolInput = z.infer<typeof writeToolInputSchema>;

export type WriteToolResponse = {
  result: WriteVaultNoteResult;
};

const maxFrontmatterKeys = 100;
const maxFrontmatterDepth = 5;
const maxFrontmatterArrayItems = 100;
const maxFrontmatterStringLength = 10_000;
const maxSerializedFrontmatterLength = 100_000;

const frontmatterKeySchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u, {
    message:
      "frontmatter keys must start with a letter and contain only letters, numbers, underscores, or hyphens",
  })
  .refine((key) => !["__proto__", "constructor", "prototype"].includes(key), {
    message: "frontmatter keys must not be prototype-polluting names",
  });

const frontmatterSchema = z
  .record(z.string(), z.unknown())
  .superRefine((frontmatter, context) => {
    for (const key of Object.keys(frontmatter)) {
      const result = frontmatterKeySchema.safeParse(key);
      if (!result.success) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: result.error.issues[0]?.message ?? "invalid frontmatter key",
        });
      }
    }

    const validationError = validateFrontmatterValue(frontmatter, 0);
    if (validationError !== undefined) {
      context.addIssue({ code: "custom", message: validationError });
    }

    const serialized = JSON.stringify(frontmatter);
    if (
      serialized !== undefined &&
      serialized.length > maxSerializedFrontmatterLength
    ) {
      context.addIssue({
        code: "custom",
        message: "frontmatter must not exceed 100000 serialized characters",
      });
    }
  });

const stringListSchema = z.array(z.string().trim().min(1).max(100)).max(50);

export const writeToolInputSchema = z.object({
  path: z.string().trim().min(1).max(500),
  body: z.string().max(200_000),
  frontmatter: frontmatterSchema.optional(),
  tags: stringListSchema.optional(),
  aliases: stringListSchema.optional(),
});

export function createWriteToolHandler(options: {
  config: McpServerConfig;
  write: typeof writeVaultNote;
}): (input: WriteToolInput) => Promise<WriteToolResponse> {
  return async (input) => {
    try {
      const parsedInput = writeToolInputSchema.parse(input);
      const result = await options.write(options.config, {
        path: parsedInput.path,
        body: parsedInput.body,
        ...(hasFrontmatter(parsedInput) || hasTagsOrAliases(parsedInput)
          ? { frontmatter: buildFrontmatter(parsedInput) }
          : {}),
      });

      return { result };
    } catch (error) {
      throw toMcpToolError(error);
    }
  };
}

function buildFrontmatter(input: WriteToolInput): Record<string, unknown> {
  return {
    ...(input.frontmatter ?? {}),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
  };
}

function hasFrontmatter(input: WriteToolInput): boolean {
  return input.frontmatter !== undefined;
}

function hasTagsOrAliases(input: WriteToolInput): boolean {
  return input.tags !== undefined || input.aliases !== undefined;
}

function validateFrontmatterValue(
  value: unknown,
  depth: number,
): string | undefined {
  if (depth > maxFrontmatterDepth) {
    return "frontmatter must not be nested deeper than 5 levels";
  }

  if (value === null || typeof value === "boolean") {
    return undefined;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? undefined
      : "frontmatter numbers must be finite";
  }

  if (typeof value === "string") {
    return value.length <= maxFrontmatterStringLength
      ? undefined
      : "frontmatter strings must not exceed 10000 characters";
  }

  if (Array.isArray(value)) {
    if (value.length > maxFrontmatterArrayItems) {
      return "frontmatter arrays must not exceed 100 items";
    }

    for (const item of value) {
      const validationError = validateFrontmatterValue(item, depth + 1);
      if (validationError !== undefined) return validationError;
    }

    return undefined;
  }

  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length > maxFrontmatterKeys) {
      return "frontmatter must not exceed 100 keys per object";
    }

    for (const [nestedKey, nestedValue] of entries) {
      const keyResult = frontmatterKeySchema.safeParse(nestedKey);
      if (!keyResult.success) {
        return keyResult.error.issues[0]?.message ?? "invalid frontmatter key";
      }

      const validationError = validateFrontmatterValue(nestedValue, depth + 1);
      if (validationError !== undefined) return validationError;
    }

    return undefined;
  }

  return "frontmatter values must be JSON-compatible";
}

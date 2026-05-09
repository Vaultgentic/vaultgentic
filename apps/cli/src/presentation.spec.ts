import { describe, expect, it } from "vitest";
import { formatCliError, shouldUseColor } from "./presentation.js";

describe("GIVEN CLI error presentation", () => {
  describe("WHEN formatting an unexpected error without debug", () => {
    describe("THEN the output stays concise", () => {
      it("SHOULD NOT include the stack trace", () => {
        const error = new Error("Unexpected failure");
        error.stack = "Error: Unexpected failure\n    at hidden";

        const output = formatCliError(error, {
          color: false,
          debug: false,
          json: false,
        });

        expect(output).toBe("Error: Unexpected failure\n");
      });
    });
  });

  describe("WITH debug enabled", () => {
    describe("WHEN formatting an unexpected error", () => {
      describe("THEN diagnostic details are included", () => {
        it("SHOULD include the stack trace", () => {
          const error = new Error("Unexpected failure");
          error.stack = "Error: Unexpected failure\n    at visible";

          const output = formatCliError(error, {
            color: false,
            debug: true,
            json: false,
          });

          expect(output).toContain("Debug details:");
          expect(output).toContain("at visible");
        });
      });
    });
  });

  describe("WITH JSON enabled", () => {
    describe("WHEN formatting an error without debug", () => {
      describe("THEN structured output excludes debug fields", () => {
        it("SHOULD print machine-readable error details", () => {
          const error = new Error("JSON failure");
          error.stack = "Error: JSON failure\n    at hidden";

          const output = formatCliError(error, {
            color: false,
            debug: false,
            json: true,
          });

          expect(JSON.parse(output)).toEqual({
            error: {
              name: "Error",
              message: "JSON failure",
              expected: false,
            },
          });
        });
      });
    });
  });

  describe("WITH an expected error field", () => {
    describe("WHEN formatting an error as JSON", () => {
      describe("THEN the error is marked expected", () => {
        it("SHOULD use the explicit error contract", () => {
          const error = Object.assign(new Error("Known failure"), {
            expected: true as const,
          });

          const output = formatCliError(error, {
            color: false,
            debug: false,
            json: true,
          });

          expect(JSON.parse(output).error.expected).toBe(true);
        });
      });
    });
  });

  describe("WITH color detection", () => {
    describe("WHEN output is not a TTY", () => {
      describe("THEN colors are disabled", () => {
        it("SHOULD NOT use color", () => {
          expect(shouldUseColor({ isTTY: false })).toBe(false);
        });
      });
    });
  });
});

import { describe, expect, it } from "vitest";
import { ConfigServiceError } from "./config.js";
import { VaultgenticError } from "./errors.js";

describe("GIVEN Vaultgentic errors", () => {
  describe("WHEN creating a core service error", () => {
    describe("THEN it exposes the expected error contract", () => {
      it("SHOULD mark the error as expected", () => {
        const error = new ConfigServiceError("Invalid config");

        expect(error).toBeInstanceOf(VaultgenticError);
        expect(error.expected).toBe(true);
      });
    });
  });

  describe("WHEN creating a generic base error", () => {
    describe("THEN expected behavior can be overridden", () => {
      it("SHOULD allow unexpected errors", () => {
        const error = new VaultgenticError("Unexpected failure", {
          expected: false,
        });

        expect(error.expected).toBe(false);
      });
    });
  });
});

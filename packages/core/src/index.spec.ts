import { describe, expect, test } from "vitest";
import { vaultgenticCoreName } from "./index.js";

describe("GIVEN the core package", () => {
  describe("WHEN importing its public entrypoint", () => {
    describe("THEN workspace wiring is available", () => {
      test("SHOULD expose the core package name", () => {
        expect(vaultgenticCoreName).toBe("vaultgentic-core");
      });
    });
  });
});

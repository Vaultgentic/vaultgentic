import { describe, expect, it } from "vitest";
import { vaultgenticCoreName } from "./index.js";

describe("GIVEN the core package", () => {
  describe("WHEN importing its public entrypoint", () => {
    describe("THEN workspace wiring is available", () => {
      it("SHOULD expose the core package name", () => {
        expect(vaultgenticCoreName).toBe("vaultgentic-core");
      });
    });
  });
});

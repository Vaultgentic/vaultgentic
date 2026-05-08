import { describe, expect, test } from "vitest";
import { createProgram, packageVersion } from "./index.js";

describe("GIVEN the CLI package", () => {
  describe("WHEN creating the Commander program", () => {
    describe("THEN command metadata is configured", () => {
      test("SHOULD use the vaultgentic command name", () => {
        expect(createProgram().name()).toBe("vaultgentic");
      });

      test("SHOULD report the package version", () => {
        expect(createProgram().version()).toBe(packageVersion);
      });
    });
  });
});

import { beforeEach, afterEach, describe, expect, it, mock } from "bun:test";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { parseDuration, resolveId } from "./utils.js";

describe("cli/utils", () => {
  beforeEach(() => {
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
    delete process.env["EMAILS_DB_PATH"];
  });

  it("parseDuration parses common units", () => {
    expect(parseDuration("30s")).toBe(30000);
    expect(parseDuration("5m")).toBe(300000);
    expect(parseDuration("2h")).toBe(7200000);
    expect(parseDuration("bad")).toBe(300000);
  });

  it("resolveId prints table-aware guidance when lookup fails", () => {
    const provider = createProvider({ name: "qa", type: "sandbox" });

    const logs: string[] = [];
    const errorSpy = mock((msg: unknown) => {
      logs.push(String(msg));
    });
    const exitSpy = mock((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    const originalError = console.error;
    const originalExit = process.exit;
    (console as unknown as { error: typeof errorSpy }).error = errorSpy;
    (process as unknown as { exit: typeof exitSpy }).exit = exitSpy;

    try {
      expect(() => resolveId("providers", provider.id.slice(0, 6))).not.toThrow();

      expect(() => resolveId("providers", "missing-prefix")).toThrow("exit:1");
      expect(logs.join("\n")).toContain("table 'providers'");
      expect(logs.join("\n")).toContain("Could not resolve ID 'missing-prefix'");
    } finally {
      (console as unknown as { error: typeof originalError }).error = originalError;
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
    }
  });
});

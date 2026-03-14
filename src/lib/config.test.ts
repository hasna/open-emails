import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

// Use a temp dir to isolate config tests from real ~/.emails
const TMP_DIR = join("/tmp", `emails-config-test-${Date.now()}`);
const origHome = process.env.HOME;

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.HOME = TMP_DIR;
  // Clear module cache so config.ts picks up the new HOME
  delete (globalThis as Record<string, unknown>).__config_cache;
});

afterEach(() => {
  process.env.HOME = origHome;
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

// Dynamically re-import to get fresh module with updated HOME
async function getConfig() {
  // Force re-evaluation by busting import cache
  const mod = await import("./config.js?" + Date.now());
  return mod;
}

describe("config", () => {
  it("loadConfig returns empty object when file does not exist", async () => {
    const { loadConfig } = await getConfig();
    expect(loadConfig()).toEqual({});
  });

  it("setConfigValue creates config file and stores value", async () => {
    const { setConfigValue, getConfigValue } = await getConfig();
    setConfigValue("test-key", "test-value");
    expect(getConfigValue("test-key")).toBe("test-value");
  });

  it("setConfigValue can store numbers", async () => {
    const { setConfigValue, getConfigValue } = await getConfig();
    setConfigValue("bounce-alert-threshold", 5);
    expect(getConfigValue("bounce-alert-threshold")).toBe(5);
  });

  it("getDefaultProviderId returns undefined when not set", async () => {
    const { getDefaultProviderId } = await getConfig();
    expect(getDefaultProviderId()).toBeUndefined();
  });

  it("getDefaultProviderId returns value when set", async () => {
    const { setConfigValue, getDefaultProviderId } = await getConfig();
    setConfigValue("default_provider", "prov-123");
    expect(getDefaultProviderId()).toBe("prov-123");
  });

  it("getFailoverProviderIds returns empty array when not set", async () => {
    const { getFailoverProviderIds } = await getConfig();
    expect(getFailoverProviderIds()).toEqual([]);
  });

  it("getFailoverProviderIds parses comma-separated ids", async () => {
    const { setConfigValue, getFailoverProviderIds } = await getConfig();
    setConfigValue("failover-providers", "id1, id2, id3");
    expect(getFailoverProviderIds()).toEqual(["id1", "id2", "id3"]);
  });

  it("loadConfig / saveConfig round-trips JSON", async () => {
    const { saveConfig, loadConfig } = await getConfig();
    saveConfig({ default_provider: "abc", "bounce-alert-threshold": 10 });
    const loaded = loadConfig();
    expect(loaded.default_provider).toBe("abc");
    expect(loaded["bounce-alert-threshold"]).toBe(10);
  });
});

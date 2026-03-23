import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  loadConfig, saveConfig, getConfigValue, setConfigValue,
  getDefaultProviderId, getFailoverProviderIds,
} from "./config.js";

// Use a temp dir unique per test run to isolate from real ~/.hasna/emails
const TMP_HOME = join("/tmp", `emails-config-test-${process.pid}`);
const origHome = process.env.HOME;

beforeEach(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env.HOME = TMP_HOME;
});

afterEach(() => {
  process.env.HOME = origHome;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("config", () => {
  it("loadConfig returns empty object when no file exists", () => {
    expect(loadConfig()).toEqual({});
  });

  it("saveConfig creates the file and directory", () => {
    saveConfig({ "my-key": "my-value" });
    expect(existsSync(join(TMP_HOME, ".hasna", "emails", "config.json"))).toBe(true);
  });

  it("loadConfig reads back saved config", () => {
    saveConfig({ "test-key": 42 });
    expect(loadConfig()["test-key"]).toBe(42);
  });

  it("getConfigValue returns value for existing key", () => {
    saveConfig({ "bounce-alert-threshold": 5 });
    expect(getConfigValue("bounce-alert-threshold")).toBe(5);
  });

  it("getConfigValue returns undefined for missing key", () => {
    expect(getConfigValue("nonexistent")).toBeUndefined();
  });

  it("setConfigValue creates and updates value", () => {
    setConfigValue("my-setting", "hello");
    expect(getConfigValue("my-setting")).toBe("hello");
    setConfigValue("my-setting", "updated");
    expect(getConfigValue("my-setting")).toBe("updated");
  });

  it("getDefaultProviderId returns undefined when not set", () => {
    expect(getDefaultProviderId()).toBeUndefined();
  });

  it("getDefaultProviderId returns set value", () => {
    setConfigValue("default_provider", "prov-abc");
    expect(getDefaultProviderId()).toBe("prov-abc");
  });

  it("getFailoverProviderIds returns empty array when not set", () => {
    expect(getFailoverProviderIds()).toEqual([]);
  });

  it("getFailoverProviderIds parses comma-separated IDs", () => {
    setConfigValue("failover-providers", "id1, id2, id3");
    expect(getFailoverProviderIds()).toEqual(["id1", "id2", "id3"]);
  });

  it("getFailoverProviderIds filters empty strings", () => {
    setConfigValue("failover-providers", "id1,,id2");
    expect(getFailoverProviderIds()).toEqual(["id1", "id2"]);
  });
});

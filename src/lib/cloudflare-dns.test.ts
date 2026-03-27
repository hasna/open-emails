import { describe, it, expect, mock, beforeEach } from "bun:test";

// ─── Mock @hasna/connect-cloudflare ──────────────────────────────────────────

type MockRecord = { id: string; type: string; name: string; content: string; ttl: number; proxied: boolean };
let mockZones: { id: string; name: string; name_servers?: string[] }[] = [];
let mockRecords: MockRecord[] = [];
let createCalled: { type: string; name: string; content: string }[] = [];

const mockCf = {
  zones: {
    list: mock(async (params?: { name?: string }) => ({
      result: params?.name
        ? mockZones.filter((z) => z.name === params.name)
        : mockZones,
      success: true, errors: [], messages: [],
    })),
  },
  dns: {
    list: mock(async (_zoneId: string, params?: { type?: string; name?: string }) => ({
      result: mockRecords.filter((r) => {
        if (params?.type && r.type !== params.type) return false;
        if (params?.name && r.name !== params.name) return false;
        return true;
      }),
      success: true, errors: [], messages: [],
    })),
    create: mock(async (_zoneId: string, params: { type: string; name: string; content: string; ttl?: number; proxied?: boolean }) => {
      createCalled.push({ type: params.type, name: params.name, content: params.content });
      const record: MockRecord = { id: `rec-${Math.random().toString(36).slice(2,8)}`, type: params.type, name: params.name, content: params.content, ttl: params.ttl ?? 300, proxied: params.proxied ?? false };
      mockRecords.push(record);
      return record;
    }),
  },
};

mock.module("@hasna/connect-cloudflare", () => ({
  Cloudflare: class {
    zones = mockCf.zones;
    dns = mockCf.dns;
    static create() { return new this(); }
    static fromEnv() { return new this(); }
  },
}));

// Set env var so getCloudflareToken() returns a value without reading config file
process.env["CLOUDFLARE_API_TOKEN"] = "mock-cf-token-for-tests";

const { findZone, upsertEmailDnsRecords, addMxRecord } = await import("./cloudflare-dns.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCf() { return mockCf as unknown as import("@hasna/connect-cloudflare").Cloudflare; }

beforeEach(() => {
  mockZones = [];
  mockRecords = [];
  createCalled = [];
  mockCf.zones.list.mockReset();
  mockCf.dns.list.mockReset();
  mockCf.dns.create.mockReset();
  mockCf.zones.list.mockImplementation(async (params?: { name?: string }) => ({
    result: params?.name ? mockZones.filter((z) => z.name === params.name) : mockZones,
    success: true, errors: [], messages: [],
  }));
  mockCf.dns.list.mockImplementation(async (_zoneId: string, params?: { type?: string; name?: string }) => ({
    result: mockRecords.filter((r) => {
      if (params?.type && r.type !== params.type) return false;
      if (params?.name && r.name !== params.name) return false;
      return true;
    }),
    success: true, errors: [], messages: [],
  }));
  mockCf.dns.create.mockImplementation(async (_zoneId: string, params: { type: string; name: string; content: string; ttl?: number; proxied?: boolean }) => {
    createCalled.push({ type: params.type, name: params.name, content: params.content });
    const record: MockRecord = { id: `rec-${Math.random().toString(36).slice(2,8)}`, type: params.type, name: params.name, content: params.content, ttl: 300, proxied: false };
    mockRecords.push(record);
    return record;
  });
});

// ─── findZone ─────────────────────────────────────────────────────────────────

describe("findZone", () => {
  it("returns zone when exact match found", async () => {
    mockZones = [{ id: "z1", name: "example.com", name_servers: ["ns1.cf.com"] }];
    const zone = await findZone(makeCf(), "example.com");
    expect(zone).not.toBeNull();
    expect(zone!.id).toBe("z1");
    expect(zone!.name).toBe("example.com");
  });

  it("finds apex zone for subdomain (mail.example.com → example.com)", async () => {
    mockZones = [{ id: "z2", name: "example.com" }];
    // First call returns nothing (exact), second returns the apex
    let callCount = 0;
    mockCf.zones.list.mockImplementation(async (params?: { name?: string }) => {
      callCount++;
      if (callCount === 1) return { result: [], success: true, errors: [], messages: [] };
      return { result: mockZones.filter((z) => z.name === params?.name), success: true, errors: [], messages: [] };
    });
    const zone = await findZone(makeCf(), "mail.example.com");
    expect(zone).not.toBeNull();
    expect(zone!.id).toBe("z2");
  });

  it("returns null when no zone found", async () => {
    mockZones = [];
    const zone = await findZone(makeCf(), "notfound.com");
    expect(zone).toBeNull();
  });
});

// ─── upsertEmailDnsRecords ────────────────────────────────────────────────────

describe("upsertEmailDnsRecords", () => {
  it("creates records that don't exist", async () => {
    const records = [
      { type: "TXT" as const, name: "example.com", value: "v=spf1 include:amazonses.com ~all", purpose: "SPF" as const },
      { type: "CNAME" as const, name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", purpose: "DKIM" as const },
    ];

    const results = await upsertEmailDnsRecords(makeCf(), "z1", records);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "created")).toBe(true);
    expect(mockCf.dns.create).toHaveBeenCalledTimes(2);
  });

  it("skips records that already exist", async () => {
    mockRecords = [
      { id: "r1", type: "TXT", name: "example.com", content: '"v=spf1 include:amazonses.com ~all"', ttl: 300, proxied: false },
    ];

    const records = [
      { type: "TXT" as const, name: "example.com", value: "v=spf1 include:amazonses.com ~all", purpose: "SPF" as const },
    ];

    const results = await upsertEmailDnsRecords(makeCf(), "z1", records);

    expect(results[0]!.status).toBe("skipped");
    expect(mockCf.dns.create).not.toHaveBeenCalled();
  });

  it("creates some and skips others", async () => {
    mockRecords = [
      { id: "r1", type: "TXT", name: "example.com", content: '"v=spf1 include:amazonses.com ~all"', ttl: 300, proxied: false },
    ];

    const records = [
      { type: "TXT" as const, name: "example.com", value: "v=spf1 include:amazonses.com ~all", purpose: "SPF" as const },
      { type: "CNAME" as const, name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", purpose: "DKIM" as const },
    ];

    const results = await upsertEmailDnsRecords(makeCf(), "z1", records);

    expect(results.find((r) => r.type === "TXT")!.status).toBe("skipped");
    expect(results.find((r) => r.type === "CNAME")!.status).toBe("created");
  });
});

// ─── addMxRecord ──────────────────────────────────────────────────────────────

describe("addMxRecord", () => {
  it("creates MX record with correct type and priority", async () => {
    const result = await addMxRecord(makeCf(), "z1", "example.com", "inbound-smtp.us-east-1.amazonaws.com", 10);

    expect(result.status).toBe("created");
    expect(result.type).toBe("MX");
    const call = createCalled[0]!;
    expect(call.type).toBe("MX");
    expect(call.content).toBe("inbound-smtp.us-east-1.amazonaws.com");
  });

  it("skips MX if already exists", async () => {
    mockRecords = [
      { id: "mx1", type: "MX", name: "example.com", content: "inbound-smtp.us-east-1.amazonaws.com", ttl: 300, proxied: false },
    ];

    const result = await addMxRecord(makeCf(), "z1", "example.com", "inbound-smtp.us-east-1.amazonaws.com");
    expect(result.status).toBe("skipped");
    expect(mockCf.dns.create).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ─── Mock AWS SDKs ────────────────────────────────────────────────────────────

const mockSesSend = mock(async (_cmd: unknown) => ({}));
const mockS3Send = mock(async (_cmd: unknown) => ({}));

mock.module("@aws-sdk/client-ses", () => ({
  SESClient: class { send = mockSesSend; },
  CreateReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
  SetActiveReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
  ListReceiptRuleSetsCommand: class { constructor(public input: unknown) {} },
  CreateReceiptRuleCommand: class { constructor(public input: unknown) {} },
  DescribeActiveReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
}));

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class { send = mockS3Send; },
  CreateBucketCommand: class { constructor(public input: unknown) {} },
  PutBucketPolicyCommand: class { constructor(public input: unknown) {} },
  PutPublicAccessBlockCommand: class { constructor(public input: unknown) {} },
  PutBucketVersioningCommand: class { constructor(public input: unknown) {} },
  PutBucketEncryptionCommand: class { constructor(public input: unknown) {} },
  HeadBucketCommand: class { constructor(public input: unknown) {} },
  ListObjectsV2Command: class { constructor(public input: unknown) {} },
  GetObjectCommand: class { constructor(public input: unknown) {} },
}));

const { setupInboundEmail } = await import("./aws-inbound.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSesSend.mockReset();
  mockS3Send.mockReset();
});

function setupMocks(bucketExists = false) {
  mockS3Send.mockImplementation(async (cmd: unknown) => {
    const name = (cmd as { constructor?: { name?: string } })?.constructor?.name ?? "";
    // HeadBucket — throw to indicate bucket doesn't exist (triggers creation path)
    if (!bucketExists && name === "HeadBucketCommand") {
      throw Object.assign(new Error("NoSuchBucket"), { name: "NoSuchBucket" });
    }
    return {};
  });

  let sesCallCount = 0;
  mockSesSend.mockImplementation(async () => {
    sesCallCount++;
    // First call = DescribeActiveReceiptRuleSet — throw to indicate no active set
    if (sesCallCount === 1) throw new Error("NoActiveRuleSet");
    // Second call = ListReceiptRuleSets — return empty
    if (sesCallCount === 2) return { RuleSets: [] };
    // Remaining calls = CreateReceiptRuleSet, SetActive, CreateRule — succeed
    return {};
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("setupInboundEmail", () => {
  it("creates bucket and receipt rule when neither exists", async () => {
    setupMocks(false);

    const result = await setupInboundEmail({
      domain: "example.com",
      bucket: "my-emails",
      region: "us-east-1",
    });

    expect(result.bucket).toBe("my-emails");
    expect(typeof result.rule_set).toBe("string");
    expect(typeof result.rule_name).toBe("string");
    expect(result.s3_prefix).toContain("inbound/example.com");
    expect(result.mx_record).toContain("inbound-smtp");
    expect(result.mx_record).toContain("us-east-1");
  });

  it("returns correct mx_record format", async () => {
    setupMocks(false);

    const result = await setupInboundEmail({
      domain: "test.com",
      bucket: "test-bucket",
      region: "eu-west-1",
    });

    expect(result.mx_record).toBe("10 inbound-smtp.eu-west-1.amazonaws.com");
  });

  it("uses default prefix inbound/<domain>/", async () => {
    setupMocks(false);

    const result = await setupInboundEmail({
      domain: "hasna.com",
      bucket: "hasna-emails",
    });

    expect(result.s3_prefix).toBe("inbound/hasna.com/");
  });

  it("respects custom prefix", async () => {
    setupMocks(false);

    const result = await setupInboundEmail({
      domain: "hasna.com",
      bucket: "hasna-emails",
      prefix: "custom/prefix/",
    });

    expect(result.s3_prefix).toBe("custom/prefix/");
  });

  it("marks bucket_created=false when bucket exists", async () => {
    // HeadBucket succeeds (bucket exists)
    mockS3Send.mockImplementation(async () => ({}));
    mockSesSend.mockImplementation(async (cmd: unknown) => {
      const c = cmd as { constructor: { name: string } };
      if (c?.constructor?.name === "DescribeActiveReceiptRuleSetCommand") throw new Error("no active");
      if (c?.constructor?.name === "ListReceiptRuleSetsCommand") return { RuleSets: [] };
      return {};
    });

    const result = await setupInboundEmail({ domain: "x.com", bucket: "existing-bucket" });
    expect(result.bucket_created).toBe(false);
  });
});

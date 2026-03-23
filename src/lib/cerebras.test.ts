import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chatCompletion, prompt, promptJson, CerebrasError } from "./cerebras.js";

const originalFetch = globalThis.fetch;
let fetchCallCount = 0;
let mockFetchFn: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;

function makeCerebrasResponse(content: string, model = "llama-4-scout-17b-16e-instruct") {
  return {
    id: "resp-test",
    object: "chat.completion",
    created: Date.now(),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
  };
}

function setMockFetch(fn: (url: string, init?: RequestInit) => Promise<Response>) {
  mockFetchFn = fn;
  // @ts-expect-error mock
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    fetchCallCount++;
    return fn(url, init);
  };
}

beforeEach(() => {
  process.env["CEREBRAS_API_KEY"] = "test-cerebras-key";
  fetchCallCount = 0;
  mockFetchFn = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env["CEREBRAS_API_KEY"];
});

describe("chatCompletion", () => {
  it("sends a request to the Cerebras API", async () => {
    setMockFetch(async (url, init) => {
      expect(url).toBe("https://api.cerebras.ai/v1/chat/completions");
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("llama-4-scout-17b-16e-instruct");
      expect(body.messages).toHaveLength(1);
      expect(init?.headers).toHaveProperty("Authorization", "Bearer test-cerebras-key");
      return new Response(JSON.stringify(makeCerebrasResponse("Hello!")));
    });

    const res = await chatCompletion({
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(res.choices[0]!.message.content).toBe("Hello!");
    expect(fetchCallCount).toBe(1);
  });

  it("uses custom model when specified", async () => {
    setMockFetch(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("custom-model");
      return new Response(JSON.stringify(makeCerebrasResponse("OK")));
    });

    await chatCompletion({
      model: "custom-model",
      messages: [{ role: "user", content: "test" }],
    });
  });

  it("enables JSON mode when json_mode is true", async () => {
    setMockFetch(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.response_format).toEqual({ type: "json_object" });
      return new Response(JSON.stringify(makeCerebrasResponse('{"result": true}')));
    });

    await chatCompletion({
      messages: [{ role: "user", content: "test" }],
      json_mode: true,
    });
  });

  it("passes temperature and max_tokens", async () => {
    setMockFetch(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.temperature).toBe(0.5);
      expect(body.max_tokens).toBe(100);
      return new Response(JSON.stringify(makeCerebrasResponse("OK")));
    });

    await chatCompletion({
      messages: [{ role: "user", content: "test" }],
      temperature: 0.5,
      max_tokens: 100,
    });
  });

  it("throws CerebrasError on 400 response", async () => {
    setMockFetch(async () => {
      return new Response(JSON.stringify({ error: { message: "Bad request", code: "invalid_request" } }), { status: 400 });
    });

    try {
      await chatCompletion({ messages: [{ role: "user", content: "test" }] });
      expect(true).toBe(false); // Should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(CerebrasError);
      expect((e as CerebrasError).status).toBe(400);
    }
  });

  it("retries on 500 errors", async () => {
    let attempts = 0;
    setMockFetch(async () => {
      attempts++;
      if (attempts <= 2) {
        return new Response("Server error", { status: 500 });
      }
      return new Response(JSON.stringify(makeCerebrasResponse("Recovered")));
    });

    const res = await chatCompletion({ messages: [{ role: "user", content: "test" }] });
    expect(res.choices[0]!.message.content).toBe("Recovered");
    expect(attempts).toBe(3);
  });

  it("throws after max retries on persistent 500", async () => {
    setMockFetch(async () => {
      return new Response("Server error", { status: 500 });
    });

    try {
      await chatCompletion({ messages: [{ role: "user", content: "test" }] });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(CerebrasError);
      expect((e as CerebrasError).status).toBe(500);
    }
  });

  it("throws when CEREBRAS_API_KEY is not set", async () => {
    delete process.env["CEREBRAS_API_KEY"];
    try {
      await chatCompletion({ messages: [{ role: "user", content: "test" }] });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(CerebrasError);
      expect((e as CerebrasError).message).toContain("CEREBRAS_API_KEY");
    }
  });
});

describe("prompt", () => {
  it("sends system + user messages and returns string", async () => {
    setMockFetch(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[1].role).toBe("user");
      return new Response(JSON.stringify(makeCerebrasResponse("The answer is 42")));
    });

    const result = await prompt("You are helpful", "What is the meaning of life?");
    expect(result).toBe("The answer is 42");
  });
});

describe("promptJson", () => {
  it("sends with json_mode and parses response", async () => {
    setMockFetch(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.response_format).toEqual({ type: "json_object" });
      return new Response(JSON.stringify(makeCerebrasResponse('{"name": "test", "value": 123}')));
    });

    const result = await promptJson<{ name: string; value: number }>("System", "User");
    expect(result.name).toBe("test");
    expect(result.value).toBe(123);
  });
});

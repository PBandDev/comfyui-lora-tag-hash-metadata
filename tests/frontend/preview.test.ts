import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPreview } from "../../src/preview";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ENTRIES = [
  {
    kind: "url",
    source: "https://civitai.com/models/2767064?modelVersionId=3114726",
    status: "resolved",
    name: "Anima Detailer",
    hash: "CD64AF8696",
  },
];

describe("fetchPreview", () => {
  it("posts the textbox content and parses the entries payload", async () => {
    const spy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(ENTRIES), { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    const entries = await fetchPreview(
      "CD64AF8696\n",
      ["D6A3AC6F8A"],
      new AbortController().signal,
    );
    const [input, init] = spy.mock.calls[0];
    expect(String(input)).toBe("/api/clth/preview");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "CD64AF8696\n",
      lora_hashes: ["D6A3AC6F8A"],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("Anima Detailer");
  });

  it("drops malformed entries via the shared payload parser", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('[{"nope":true}]', { status: 200 })),
    );
    expect(await fetchPreview("x", [], new AbortController().signal)).toEqual([]);
  });

  it("throws on http errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(fetchPreview("x", [], new AbortController().signal)).rejects.toThrow("500");
  });
});

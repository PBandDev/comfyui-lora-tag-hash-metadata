import { afterEach, describe, expect, it, vi } from "vitest";
import { lmAvailable, searchLocalLoras } from "../../src/lmLocal";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lmAvailable", () => {
  it("true on 200, false on error status, false on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect(await lmAvailable()).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect(await lmAvailable()).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    expect(await lmAvailable()).toBe(false);
  });
});

describe("searchLocalLoras", () => {
  const payload = {
    items: [
      {
        model_name: "Anima Detailer",
        file_name: "anima_detailer_v0_8",
        folder: "Illustrious/anime",
        sha256: "cd64af8696aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        preview_url: "/api/lm/previews?path=x",
        civitai: { id: 3114726, modelId: 2767064 },
      },
      {
        model_name: "orphan",
        file_name: "orphan",
        folder: "",
        sha256: "0f3c77a1de55d2e90bc1b7a0299f44aa0f3c77a1de55d2e90bc1b7a0299f44",
        preview_url: null,
        civitai: null,
      },
    ],
  };

  it("maps items, requesting fuzzy search when a query is given", async () => {
    const spy = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify(payload), { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    const rows = await searchLocalLoras("anima", new AbortController().signal);
    const url = new URL(String(spy.mock.calls[0][0]), "http://localhost");
    expect(url.pathname).toBe("/api/lm/loras/list");
    expect(url.searchParams.get("search")).toBe("anima");
    expect(url.searchParams.get("fuzzy")).toBe("true");
    expect(url.searchParams.get("page_size")).toBe("200");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      displayName: "Anima Detailer",
      modelId: 2767064,
      versionId: 3114726,
    });
    expect(rows[1]).toMatchObject({ modelId: null, versionId: null });
    expect(rows[1].sha256).toContain("0f3c77a1de");
  });

  it("omits search params for the browse (empty query) case", async () => {
    const spy = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    await searchLocalLoras("", new AbortController().signal);
    const url = new URL(String(spy.mock.calls[0][0]), "http://localhost");
    expect(url.searchParams.has("search")).toBe(false);
  });

  it("throws on http error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(searchLocalLoras("x", new AbortController().signal)).rejects.toThrow("500");
  });
});

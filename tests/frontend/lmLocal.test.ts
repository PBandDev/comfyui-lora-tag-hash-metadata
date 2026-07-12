import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_KINDS, lmAvailable, searchLocalModels } from "../../src/lmLocal";

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

describe("searchLocalModels", () => {
  const loraPayload = {
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

  function itemsFor(name: string): string {
    return JSON.stringify({
      items: [
        {
          model_name: name,
          file_name: name,
          folder: "",
          sha256: "56cf07076f0000000000000000000000000000000000000000000000000000",
          preview_url: null,
          civitai: null,
        },
      ],
    });
  }

  it("maps items, sending both fuzzy flags when a query is given", async () => {
    const spy = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify(loraPayload), { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    const result = await searchLocalModels(["loras"], "anima", new AbortController().signal);
    const url = new URL(String(spy.mock.calls[0][0]), "http://localhost");
    expect(url.pathname).toBe("/api/lm/loras/list");
    expect(url.searchParams.get("search")).toBe("anima");
    expect(url.searchParams.get("fuzzy")).toBe("true");
    expect(url.searchParams.get("fuzzy_search")).toBe("true");
    // LM clamps page_size to 100 server-side — asking for more just hides
    // the truncation.
    expect(url.searchParams.get("page_size")).toBe("100");
    expect(result.failedKinds).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      kind: "loras",
      displayName: "Anima Detailer",
      modelId: 2767064,
      versionId: 3114726,
    });
    expect(result.rows[1]).toMatchObject({ modelId: null, versionId: null });
    expect(result.rows[1].sha256).toContain("0f3c77a1de");
  });

  it("fans out one request per kind and merges rows in kind order", async () => {
    const spy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/lm/loras/list")) return new Response(itemsFor("a_lora"), { status: 200 });
      if (url.includes("/api/lm/checkpoints/list"))
        return new Response(itemsFor("a_ckpt"), { status: 200 });
      return new Response(itemsFor("an_embed"), { status: 200 });
    });
    vi.stubGlobal("fetch", spy);
    const result = await searchLocalModels(LOCAL_KINDS, "", new AbortController().signal);
    expect(spy).toHaveBeenCalledTimes(3);
    const paths = spy.mock.calls.map((call) => new URL(String(call[0]), "http://x").pathname);
    expect(paths).toEqual([
      "/api/lm/loras/list",
      "/api/lm/checkpoints/list",
      "/api/lm/embeddings/list",
    ]);
    expect(result.rows.map((row) => row.kind)).toEqual(["loras", "checkpoints", "embeddings"]);
    expect(result.failedKinds).toEqual([]);
  });

  it("omits search params for the browse (empty query) case", async () => {
    const spy = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    await searchLocalModels(["loras"], "", new AbortController().signal);
    const url = new URL(String(spy.mock.calls[0][0]), "http://localhost");
    expect(url.searchParams.has("search")).toBe(false);
  });

  it("flags kinds whose reported total exceeds the returned page as truncated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const payload = JSON.parse(itemsFor("one")) as { items: unknown[] };
        // loras claims 150 total but returns 1 item; others are complete.
        const total = url.includes("/api/lm/loras/list") ? 150 : 1;
        return new Response(JSON.stringify({ ...payload, total }), { status: 200 });
      }),
    );
    const result = await searchLocalModels(LOCAL_KINDS, "", new AbortController().signal);
    expect(result.truncatedKinds).toEqual(["loras"]);
    // absent total (older LM) must not flag truncation
    vi.stubGlobal("fetch", vi.fn(async () => new Response(itemsFor("one"), { status: 200 })));
    const legacy = await searchLocalModels(["loras"], "", new AbortController().signal);
    expect(legacy.truncatedKinds).toEqual([]);
  });

  it("keeps working kinds and reports the failed one (older LM w/o a route)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/lm/embeddings/list")) return new Response("", { status: 404 });
        return new Response(itemsFor("ok"), { status: 200 });
      }),
    );
    const result = await searchLocalModels(LOCAL_KINDS, "x", new AbortController().signal);
    expect(result.rows.map((row) => row.kind)).toEqual(["loras", "checkpoints"]);
    expect(result.failedKinds).toEqual(["embeddings"]);
  });

  it("throws when every requested kind fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(
      searchLocalModels(LOCAL_KINDS, "x", new AbortController().signal),
    ).rejects.toThrow("500");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSearchUrl,
  searchModels,
  thumbnailUrl,
  typeAcceptsWeight,
} from "../../src/civitaiSearch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildSearchUrl", () => {
  it("always sets nsfw=true and a limit", () => {
    const url = new URL(buildSearchUrl({}));
    expect(url.origin + url.pathname).toBe("https://civitai.com/api/v1/models");
    expect(url.searchParams.get("nsfw")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("20");
  });

  it("encodes query, type, sort, cursor", () => {
    const url = new URL(
      buildSearchUrl({
        query: "anima detailer",
        type: "LORA",
        sort: "Most Downloaded",
        cursor: "abc|123",
        limit: 40,
      }),
    );
    expect(url.searchParams.get("query")).toBe("anima detailer");
    expect(url.searchParams.getAll("types")).toEqual(["LORA"]);
    expect(url.searchParams.get("sort")).toBe("Most Downloaded");
    expect(url.searchParams.get("cursor")).toBe("abc|123");
    expect(url.searchParams.get("limit")).toBe("40");
  });

  it("omits query/types/sort/cursor when unset", () => {
    const url = new URL(buildSearchUrl({}));
    for (const key of ["query", "types", "sort", "cursor"]) {
      expect(url.searchParams.has(key)).toBe(false);
    }
  });
});

describe("thumbnailUrl", () => {
  it("rewrites the transform segment", () => {
    expect(thumbnailUrl("https://image.civitai.com/x/uuid/original=true/1.jpeg")).toBe(
      "https://image.civitai.com/x/uuid/width=96,anim=false/1.jpeg",
    );
    expect(thumbnailUrl("https://image.civitai.com/x/uuid/width=450,fit=cover/1.jpeg")).toBe(
      "https://image.civitai.com/x/uuid/width=96,anim=false/1.jpeg",
    );
  });
});

describe("typeAcceptsWeight", () => {
  it("only lora-ish types take weights", () => {
    expect(typeAcceptsWeight("LORA")).toBe(true);
    expect(typeAcceptsWeight("LoCon")).toBe(true);
    expect(typeAcceptsWeight("DoRA")).toBe(true);
    expect(typeAcceptsWeight("TextualInversion")).toBe(true);
    expect(typeAcceptsWeight("Checkpoint")).toBe(false);
    expect(typeAcceptsWeight("Workflows")).toBe(false);
    expect(typeAcceptsWeight("Other")).toBe(false);
  });
});

describe("searchModels", () => {
  const payload = {
    items: [
      {
        id: 2767064,
        name: "Anima Detailer",
        type: "LORA",
        creator: { username: "Volnovik" },
        stats: { downloadCount: 249 },
        modelVersions: [
          {
            id: 3114726,
            name: "v0_8",
            baseModel: "Anima",
            images: [{ url: "https://image.civitai.com/x/u/original=true/9.jpeg", type: "image" }],
          },
        ],
      },
      { name: "junk without id" },
    ],
    metadata: { nextCursor: "next|1" },
  };

  it("maps items and cursor, skipping malformed entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );
    const page = await searchModels({ query: "anima" }, new AbortController().signal);
    expect(page.nextCursor).toBe("next|1");
    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    expect(item).toMatchObject({
      id: 2767064,
      name: "Anima Detailer",
      type: "LORA",
      creator: "Volnovik",
      downloads: 249,
    });
    expect(item.thumbnail).toContain("width=96,anim=false");
    expect(item.versions).toEqual([{ id: 3114726, name: "v0_8", baseModel: "Anima" }]);
  });

  it("throws on http errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 400 })));
    await expect(searchModels({}, new AbortController().signal)).rejects.toThrow("400");
  });

  it("sends no custom headers (CORS simple request)", async () => {
    const spy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    await searchModels({}, new AbortController().signal);
    expect(spy.mock.calls[0][1]?.headers).toBeUndefined();
  });
});

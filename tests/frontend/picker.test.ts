import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openResourcePicker } from "../../src/picker";

const SEARCH_PAYLOAD = {
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
          images: [{ url: "https://image.civitai.com/x/u/original=true/9.jpeg" }],
        },
      ],
    },
    {
      id: 2458426,
      name: "Anima",
      type: "Checkpoint",
      creator: { username: "circlestone_labs" },
      stats: { downloadCount: 121046 },
      modelVersions: [{ id: 3108589, name: "turbo-v1.0", baseModel: "Anima", images: [] }],
    },
  ],
  metadata: { nextCursor: "cur|2" },
};

function stubFetch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/lm/health-check")) return new Response("", { status: 404 });
    return new Response(JSON.stringify(SEARCH_PAYLOAD), { status: 200 });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let text: string;
let close: (() => void) | undefined;

beforeEach(() => {
  text = "";
  close = undefined;
  stubFetch();
});

afterEach(() => {
  close?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function open(): void {
  close =
    openResourcePicker({
      getText: () => text,
      setText: (value) => {
        text = value;
      },
    }) ?? undefined;
}

describe("openResourcePicker", () => {
  it("mounts one overlay, loads the browse feed, and injects styles once", async () => {
    open();
    await flush();
    expect(document.querySelectorAll(".clth-pk-overlay")).toHaveLength(1);
    expect(document.querySelectorAll("#clth-picker-styles-v1")).toHaveLength(1);
    expect(document.querySelectorAll(".clth-pk-card")).toHaveLength(2);
    // second open is rejected while one is active
    const again = openResourcePicker({ getText: () => text, setText: () => undefined });
    expect(again).toBeNull();
    expect(document.querySelectorAll(".clth-pk-overlay")).toHaveLength(1);
  });

  it("stages an add and applies it as a pinned line", async () => {
    open();
    await flush();
    const card = document.querySelectorAll<HTMLElement>(".clth-pk-card")[0];
    card.querySelector<HTMLButtonElement>(".clth-pk-add")?.click();
    document.querySelector<HTMLButtonElement>(".clth-pk-apply")?.click();
    expect(text).toBe("https://civitai.com/models/2767064?modelVersionId=3114726");
    expect(document.querySelector(".clth-pk-overlay")).toBeNull();
  });

  it("includes the weight suffix for lora-ish cards only", async () => {
    open();
    await flush();
    const cards = document.querySelectorAll<HTMLElement>(".clth-pk-card");
    // LORA card has a weight input, Checkpoint card does not
    const weightInput = cards[0].querySelector<HTMLInputElement>(".clth-pk-weight");
    expect(weightInput).not.toBeNull();
    expect(cards[1].querySelector(".clth-pk-weight")).toBeNull();
    if (weightInput !== null) weightInput.value = "0.8";
    cards[0].querySelector<HTMLButtonElement>(".clth-pk-add")?.click();
    document.querySelector<HTMLButtonElement>(".clth-pk-apply")?.click();
    expect(text).toBe("https://civitai.com/models/2767064?modelVersionId=3114726 0.8");
  });

  it("shows Remove for versions already in the textbox and applies the removal", async () => {
    text = "# keep me\nhttps://civitai.com/models/2767064?modelVersionId=3114726 0.8";
    open();
    await flush();
    const button = document.querySelectorAll<HTMLElement>(".clth-pk-card")[0]
      .querySelector<HTMLButtonElement>(".clth-pk-add");
    expect(button?.textContent).toBe("Remove");
    button?.click();
    document.querySelector<HTMLButtonElement>(".clth-pk-apply")?.click();
    expect(text).toBe("# keep me");
  });

  it("debounces typing before searching", async () => {
    vi.useFakeTimers();
    open();
    await vi.advanceTimersByTimeAsync(0);
    const spy = vi.mocked(fetch);
    const before = spy.mock.calls.length;
    const input = document.querySelector<HTMLInputElement>(".clth-pk-search");
    if (input === null) throw new Error("no search input");
    input.value = "anima";
    input.dispatchEvent(new Event("input"));
    expect(spy.mock.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(350);
    expect(spy.mock.calls.length).toBe(before + 1);
    expect(String(spy.mock.calls[spy.mock.calls.length - 1]?.[0])).toContain("query=anima");
  });

  it("closes on Escape and removes its capture listeners", async () => {
    open();
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".clth-pk-overlay")).toBeNull();
    // A leaked capture listener would stopImmediatePropagation and shield the
    // next picker from Escape — reopen and prove the fresh one still closes.
    open();
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".clth-pk-overlay")).toBeNull();
  });

  it("typing immediately invalidates the old cursor and Load more", async () => {
    open();
    await flush();
    expect(document.querySelector(".clth-pk-more")).not.toBeNull();
    const input = document.querySelector<HTMLInputElement>(".clth-pk-search");
    if (input === null) throw new Error("no search input");
    input.value = "anima";
    input.dispatchEvent(new Event("input"));
    // Before the debounce fires, pagination from the previous query is gone.
    expect(document.querySelector(".clth-pk-more")).toBeNull();
  });

  it("locks version and weight controls while staged", async () => {
    open();
    await flush();
    const card = document.querySelectorAll<HTMLElement>(".clth-pk-card")[0];
    const weight = card.querySelector<HTMLInputElement>(".clth-pk-weight");
    const select = card.querySelector<HTMLSelectElement>(".clth-pk-versions");
    const add = card.querySelector<HTMLButtonElement>(".clth-pk-add");
    if (weight === null || select === null || add === null) throw new Error("missing controls");
    weight.value = "0.8";
    add.click();
    expect(weight.disabled).toBe(true);
    expect(select.disabled).toBe(true);
    add.click(); // unstage
    expect(weight.disabled).toBe(false);
    expect(select.disabled).toBe(false);
  });

  it("shows a search failure without crashing on non-Error rejections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/lm/health-check")) return new Response("", { status: 404 });
        return Promise.reject("boom");
      }),
    );
    open();
    await flush();
    expect(document.querySelector(".clth-pk-status")?.textContent).toContain(
      "Search failed: boom",
    );
  });

  it("hides the Local tab when LM health-check fails", async () => {
    open();
    await flush();
    expect(document.querySelector(".clth-pk-tab-local")).toBeNull();
  });

  it("shows the Local tab when LM answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/lm/health-check")) return new Response("{}", { status: 200 });
        if (url.includes("/api/lm/loras/list")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  model_name: "Anima Detailer",
                  file_name: "anima_detailer_v0_8",
                  folder: "Illustrious/anime",
                  sha256: "cd64af8696000000000000000000000000000000000000000000000000000000",
                  preview_url: null,
                  civitai: { id: 3114726, modelId: 2767064 },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/api/lm/checkpoints/list") || url.includes("/api/lm/embeddings/list")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        return new Response(JSON.stringify(SEARCH_PAYLOAD), { status: 200 });
      }),
    );
    open();
    await flush();
    const tab = document.querySelector<HTMLButtonElement>(".clth-pk-tab-local");
    expect(tab).not.toBeNull();
    tab?.click();
    await flush();
    const row = document.querySelector<HTMLElement>(".clth-pk-card");
    expect(row?.textContent).toContain("Anima Detailer");
    row?.querySelector<HTMLButtonElement>(".clth-pk-add")?.click();
    document.querySelector<HTMLButtonElement>(".clth-pk-apply")?.click();
    expect(text).toBe("https://civitai.com/models/2767064?modelVersionId=3114726");
  });

  it("local tab lists all LM kinds, filters via chips, weights only weighted kinds", async () => {
    const localItem = (name: string, sha: string) => ({
      model_name: name,
      file_name: name,
      folder: "",
      sha256: sha,
      preview_url: null,
      civitai: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/lm/health-check")) return new Response("{}", { status: 200 });
        if (url.includes("/api/lm/loras/list")) {
          return new Response(
            JSON.stringify({
              items: [
                localItem(
                  "a_lora",
                  "1111111111000000000000000000000000000000000000000000000000000000",
                ),
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/api/lm/checkpoints/list")) {
          return new Response(
            JSON.stringify({
              items: [
                // Letter-bearing sha so the AutoV2 uppercase path is actually
                // asserted (digits are casing-blind).
                localItem(
                  "a_ckpt",
                  "abcdef1234000000000000000000000000000000000000000000000000000000",
                ),
                // LM hashes checkpoints lazily — a fresh unmatched one has an
                // empty sha256 and must degrade to a disabled "no hash" row.
                localItem("pending_ckpt", ""),
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/api/lm/embeddings/list")) {
          return new Response(
            JSON.stringify({
              items: [
                localItem(
                  "an_embed",
                  "3333333333000000000000000000000000000000000000000000000000000000",
                ),
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(SEARCH_PAYLOAD), { status: 200 });
      }),
    );
    open();
    await flush();
    document.querySelector<HTMLButtonElement>(".clth-pk-tab-local")?.click();
    await flush();

    const cards = document.querySelectorAll<HTMLElement>(".clth-pk-card");
    expect(cards).toHaveLength(4);
    expect(cards[0].textContent).toContain("a_lora");
    expect(cards[1].textContent).toContain("a_ckpt");
    expect(cards[2].textContent).toContain("pending_ckpt");
    expect(cards[3].textContent).toContain("an_embed");
    // weights: lora yes, checkpoint no, embedding yes
    expect(cards[0].querySelector(".clth-pk-weight")).not.toBeNull();
    expect(cards[1].querySelector(".clth-pk-weight")).toBeNull();
    expect(cards[3].querySelector(".clth-pk-weight")).not.toBeNull();
    // hashless (LM lazy-hash) checkpoint: disabled button, remediation hint
    const pendingButton = cards[2].querySelector<HTMLButtonElement>(".clth-pk-add");
    expect(pendingButton?.disabled).toBe(true);
    expect(pendingButton?.textContent).toBe("no hash");
    expect(pendingButton?.title).toContain("LoRA Manager");

    // kind chips replace the civitai type chips on this tab
    const chipLabels = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".clth-pk-chip"),
      (chip) => chip.textContent,
    );
    expect(chipLabels).toEqual(["All", "LoRAs", "Checkpoints", "Embeddings"]);

    const checkpointChip = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".clth-pk-chip"),
    ).find((chip) => chip.textContent === "Checkpoints");
    checkpointChip?.click();
    await flush();
    const filtered = document.querySelectorAll<HTMLElement>(".clth-pk-card");
    expect(filtered).toHaveLength(2);
    expect(filtered[0].textContent).toContain("a_ckpt");

    // unmatched checkpoint stages its UPPERCASED AutoV2 hash line
    filtered[0].querySelector<HTMLButtonElement>(".clth-pk-add")?.click();
    document.querySelector<HTMLButtonElement>(".clth-pk-apply")?.click();
    expect(text).toBe("ABCDEF1234");
  });

  it("can reopen after an internal close and applies mixed add + removal", async () => {
    text = "https://civitai.com/models/2458426?modelVersionId=3108589";
    open();
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".clth-pk-overlay")).toBeNull();

    open(); // the singleton guard must have been released by the internal close
    await flush();
    const cards = document.querySelectorAll<HTMLElement>(".clth-pk-card");
    cards[0].querySelector<HTMLButtonElement>(".clth-pk-add")?.click(); // stage add (LORA)
    const removeButton = cards[1].querySelector<HTMLButtonElement>(".clth-pk-add");
    expect(removeButton?.textContent).toBe("Remove"); // checkpoint version already in node
    removeButton?.click(); // stage removal
    document.querySelector<HTMLButtonElement>(".clth-pk-apply")?.click();
    expect(text).toBe("https://civitai.com/models/2767064?modelVersionId=3114726");
  });

  it("closing immediately after open leaves no live listeners", async () => {
    open();
    close?.(); // before the deferred capture-listener attach fires
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); // must not throw
    open(); // and a fresh picker still opens
    await flush();
    expect(document.querySelectorAll(".clth-pk-overlay")).toHaveLength(1);
  });

  it("offers a CivitAI deep link when the public API returns nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/lm/health-check")) return new Response("", { status: 404 });
        return new Response(JSON.stringify({ items: [], metadata: {} }), { status: 200 });
      }),
    );
    open();
    await flush();
    const empty = document.querySelector<HTMLElement>(".clth-pk-empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("additional models may be available on");
    const link = empty?.querySelector<HTMLAnchorElement>("a");
    expect(link?.textContent).toBe("CivitAI");
    expect(link?.target).toBe("_blank");
    // Empty search box → the deep link query is left blank.
    expect(link?.getAttribute("href")).toMatch(/query=$/);
  });

  it("encodes the typed query into the empty-state CivitAI link", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/lm/health-check")) return new Response("", { status: 404 });
        return new Response(JSON.stringify({ items: [], metadata: {} }), { status: 200 });
      }),
    );
    open();
    await vi.advanceTimersByTimeAsync(0);
    const input = document.querySelector<HTMLInputElement>(".clth-pk-search");
    if (input === null) throw new Error("no search input");
    input.value = "diana pragmata";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(350);
    const link = document.querySelector<HTMLAnchorElement>(".clth-pk-empty a");
    expect(link?.getAttribute("href")).toContain("query=diana%20pragmata");
  });

  it("labels the weight input on lora cards but not on checkpoints", async () => {
    open();
    await flush();
    const cards = document.querySelectorAll<HTMLElement>(".clth-pk-card");
    const label = cards[0].querySelector<HTMLElement>(".clth-pk-wt-label");
    expect(label?.textContent).toBe("wt");
    expect(cards[1].querySelector(".clth-pk-wt-label")).toBeNull();
  });

  it("links the card name to the civitai model page for the selected version", async () => {
    open();
    await flush();
    const link = document
      .querySelectorAll<HTMLElement>(".clth-pk-card")[0]
      .querySelector<HTMLAnchorElement>(".clth-pk-name a");
    expect(link?.getAttribute("href")).toBe(
      "https://civitai.com/models/2767064?modelVersionId=3114726",
    );
  });
});

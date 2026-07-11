import { describe, expect, it, vi } from "vitest";
import { buildStatusList, parseStatusPayload, type ResourceEntry } from "../../src/statusList";

const entries: ResourceEntry[] = [
  {
    kind: "url",
    source: "https://civitai.com/models/2767064",
    status: "resolved",
    name: "Anima Detailer",
    type: "LORA",
    hash: "CD64AF8696",
    model_id: 2767064,
    version_id: 3114726,
    version_name: "v0_8",
    weight: null,
    unverified: false,
    error: null,
  },
  {
    kind: "url",
    source: "https://civitai.com/models/999999999",
    status: "missing",
    name: null,
    type: null,
    hash: null,
    model_id: null,
    version_id: null,
    version_name: null,
    weight: null,
    unverified: false,
    error: "not found: /api/v1/models/999999999",
  },
];

describe("buildStatusList", () => {
  it("renders resolved row with civitai link", () => {
    const el = buildStatusList(entries);
    const link = el.querySelector<HTMLAnchorElement>("a");
    expect(link?.href).toBe("https://civitai.com/models/2767064?modelVersionId=3114726");
    expect(el.textContent).toContain("Anima Detailer");
    expect(el.textContent).toContain("LORA");
    expect(el.textContent).toContain("v0_8");
  });

  it("renders failure row with reason", () => {
    const el = buildStatusList(entries);
    expect(el.textContent).toContain("not found");
    expect(el.querySelectorAll("[data-status='missing']").length).toBe(1);
  });

  it("renders duplicate row with marker", () => {
    const el = buildStatusList([
      { ...entries[0], status: "duplicate" },
    ]);
    expect(el.querySelectorAll("[data-status='duplicate']").length).toBe(1);
    expect(el.textContent).toContain("duplicate");
  });

  it("renders empty state", () => {
    expect(buildStatusList([]).textContent).toContain("No resources");
  });

  it("renders warning suffix on capped entries", () => {
    const el = buildStatusList([
      { ...entries[0], warning: "beyond Image Saver's 30-entry manual cap — may be ignored" },
    ]);
    expect(el.textContent).toContain("⚠");
    expect(el.textContent).toContain("30-entry");
  });

  it("renders a thumbnail image when present, glyph placeholder otherwise", () => {
    const withThumb = buildStatusList([
      { ...entries[0], thumbnail: "https://image.civitai.com/x/width=96,anim=false/1.jpeg" },
    ]);
    expect(withThumb.querySelector("img")?.src).toContain("width=96");

    const withoutThumb = buildStatusList(entries);
    expect(withoutThumb.querySelector("img")).toBeNull();
    expect(withoutThumb.querySelector(".clth-thumb-glyph")?.textContent).toBe("L");
  });

  it("does not link missing rows", () => {
    const el = buildStatusList([{ ...entries[1], model_id: 999999999 }]);
    expect(el.querySelector("a")).toBeNull();
  });

  it("injects the stylesheet once", () => {
    buildStatusList(entries);
    buildStatusList(entries);
    expect(document.querySelectorAll("#clth-status-styles-v1").length).toBe(1);
  });

  it("renders a remove button only for rows with a source line", () => {
    const onRemove = vi.fn();
    const el = buildStatusList(
      [
        entries[0], // url row — has source
        { kind: "lora", status: "resolved", name: "local", hash: "AB12CD34EF" }, // v1 row — no source
      ],
      { onRemove },
    );
    const buttons = el.querySelectorAll<HTMLButtonElement>(".clth-x");
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    expect(onRemove).toHaveBeenCalledWith(entries[0]);
  });

  it("renders no remove buttons without an onRemove callback", () => {
    expect(buildStatusList(entries).querySelector(".clth-x")).toBeNull();
  });

  it("renders a refresh button when onRefresh is given, even for the empty state", () => {
    const onRefresh = vi.fn();
    const el = buildStatusList([], { onRefresh });
    const button = el.querySelector<HTMLButtonElement>(".clth-refresh");
    expect(button).not.toBeNull();
    button?.click();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(buildStatusList(entries).querySelector(".clth-refresh")).toBeNull();
  });

  it("renders a note footer when given", () => {
    const el = buildStatusList(entries, { note: "preview — queue a prompt to finalize" });
    expect(el.querySelector(".clth-note")?.textContent).toContain("preview");
    expect(buildStatusList(entries).querySelector(".clth-note")).toBeNull();
  });

  it("keeps the note on empty renders (comment-only preview)", () => {
    const el = buildStatusList([], { note: "preview — queue a prompt to finalize" });
    expect(el.querySelector(".clth-note")?.textContent).toContain("preview");
    expect(el.querySelector(".clth-empty")).not.toBeNull();
  });
});

describe("parseStatusPayload", () => {
  it("parses a valid payload", () => {
    const parsed = parseStatusPayload(JSON.stringify(entries));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("Anima Detailer");
  });

  it("returns empty on junk", () => {
    expect(parseStatusPayload("not json")).toEqual([]);
    expect(parseStatusPayload('{"a":1}')).toEqual([]);
    expect(parseStatusPayload('[{"nope":true}]')).toEqual([]);
  });

  it("keeps v1 lora entries missing optional fields", () => {
    const parsed = parseStatusPayload(
      '[{"kind":"lora","name":"foo","hash":"AB12CD34EF","weight":0.8,"status":"resolved"}]',
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe("lora");
  });
});

import { describe, expect, it } from "vitest";
import { upstreamLoadedLoras, type UpstreamHostLike, type UpstreamWidgetLike } from "../../src/upstreamLoras";

function host(widgets: UpstreamWidgetLike[]): UpstreamHostLike {
  return {
    inputs: [{ name: "loaded_loras", link: 3 }],
    graph: {
      links: new Map([[3, { origin_id: 7 }]]),
      getNodeById: (id) => (id === 7 ? { widgets } : null),
    },
  };
}

const panel = (entries: object[]): UpstreamWidgetLike => ({
  name: "loras",
  value: { __value__: entries },
});

describe("upstreamLoadedLoras", () => {
  it("returns null (unreadable) without a link, graph, or resolvable origin", () => {
    expect(upstreamLoadedLoras({})).toBeNull();
    expect(upstreamLoadedLoras({ inputs: [{ name: "loaded_loras", link: null }] })).toBeNull();
    expect(
      upstreamLoadedLoras({
        inputs: [{ name: "loaded_loras", link: 3 }],
        graph: { links: new Map(), getNodeById: () => null },
      }),
    ).toBeNull();
  });

  it("returns null when the producer has no panel and no tag text", () => {
    expect(upstreamLoadedLoras(host([{ name: "seed", value: 42 }]))).toBeNull();
  });

  it("synthesizes tags from the loras panel, defaulting strength to 1", () => {
    const node = host([
      panel([
        { name: "fisheye_slider_v10", strength: 0.8, active: true },
        { name: "weather_slider_v1", active: true },
      ]),
    ]);
    expect(upstreamLoadedLoras(node)).toBe(
      "<lora:fisheye_slider_v10:0.8> <lora:weather_slider_v1:1>",
    );
  });

  it("excludes panel entries toggled inactive", () => {
    const node = host([
      panel([
        { name: "age_slider_v20", strength: 1, active: false },
        { name: "fisheye_slider_v10", strength: 1, active: true },
      ]),
    ]);
    expect(upstreamLoadedLoras(node)).toBe("<lora:fisheye_slider_v10:1>");
  });

  it("panel beats the synced tag text, which keeps disabled loras", () => {
    // LM's text widget deliberately retains toggled-off tags; run-time loads
    // from the panel only — preview must match the run.
    const node = host([
      { name: "text", value: "<lora:age_slider_v20:1> <lora:fisheye_slider_v10:1>" },
      panel([
        { name: "age_slider_v20", strength: 1, active: false },
        { name: "fisheye_slider_v10", strength: 1, active: true },
      ]),
    ]);
    expect(upstreamLoadedLoras(node)).toBe("<lora:fisheye_slider_v10:1>");
  });

  it("all-disabled panel previews as no loras, not the stale text", () => {
    const node = host([
      { name: "text", value: "<lora:age_slider_v20:1>" },
      panel([{ name: "age_slider_v20", strength: 1, active: false }]),
    ]);
    // "" (authoritative zero), NOT null — the caller must not fall back to
    // last-run rows either.
    expect(upstreamLoadedLoras(node)).toBe("");
  });

  it("excludes entries missing the active flag (python: lora.get('active', False))", () => {
    const node = host([
      panel([{ name: "no_flag", strength: 1 }, { name: "on", strength: 1, active: true }]),
    ]);
    expect(upstreamLoadedLoras(node)).toBe("<lora:on:1>");
  });

  it("parses string strengths (LM's arrow controls store toFixed strings)", () => {
    const node = host([
      panel([
        { name: "fisheye_slider_v10", strength: "0.80", active: true },
        { name: "weather_slider_v1", strength: "bogus", active: true },
      ]),
    ]);
    expect(upstreamLoadedLoras(node)).toBe(
      "<lora:fisheye_slider_v10:0.8> <lora:weather_slider_v1:1>",
    );
  });

  it("skips panel entries without a usable name", () => {
    const node = host([
      panel([{ strength: 1, active: true }, { name: "", active: true }, { name: "ok", active: true }]),
    ]);
    expect(upstreamLoadedLoras(node)).toBe("<lora:ok:1>");
  });

  it("accepts an unwrapped panel array", () => {
    const node = host([
      { name: "loras", value: [{ name: "fisheye_slider_v10", strength: 0.5, active: true }] },
    ]);
    expect(upstreamLoadedLoras(node)).toBe("<lora:fisheye_slider_v10:0.5>");
  });

  it("falls back to a plain lora-tag string widget when no panel exists", () => {
    const node = host([
      { name: "anything", value: "prefix <lora:fisheye_slider_v10:0.7> suffix" },
    ]);
    expect(upstreamLoadedLoras(node)).toBe("prefix <lora:fisheye_slider_v10:0.7> suffix");
  });

  it("ignores a string-valued widget named loras (not a panel)", () => {
    const node = host([{ name: "loras", value: "<lora:fisheye_slider_v10:1>" }]);
    expect(upstreamLoadedLoras(node)).toBe("<lora:fisheye_slider_v10:1>");
  });

  it("a non-array object named loras is not a panel — string fallback still wins", () => {
    const node = host([
      { name: "loras", value: { some: "config" } },
      { name: "text", value: "<lora:fisheye_slider_v10:1>" },
    ]);
    expect(upstreamLoadedLoras(node)).toBe("<lora:fisheye_slider_v10:1>");
  });

  it("resolves links stored as a plain record", () => {
    const node: UpstreamHostLike = {
      inputs: [{ name: "loaded_loras", link: 3 }],
      graph: {
        links: { 3: { origin_id: 7 } },
        getNodeById: (id) =>
          id === 7 ? { widgets: [panel([{ name: "ok", strength: 1, active: true }])] } : null,
      },
    };
    expect(upstreamLoadedLoras(node)).toBe("<lora:ok:1>");
  });
});

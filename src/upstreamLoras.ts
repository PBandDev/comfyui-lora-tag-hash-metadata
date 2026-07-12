// Best-effort read of the linked loaded_loras producer's widget state, so a
// preview can include lora rows BEFORE any run.

export interface UpstreamWidgetLike {
  name: string;
  value?: string | number | boolean | object;
}

export interface UpstreamLinkLike {
  origin_id: number;
}

export interface UpstreamNodeLike {
  widgets?: UpstreamWidgetLike[];
}

export interface UpstreamGraphLike {
  links?:
    | Map<number, UpstreamLinkLike | undefined>
    | Record<number, UpstreamLinkLike | undefined>;
  getNodeById?(id: number): UpstreamNodeLike | null;
}

export interface UpstreamHostLike {
  inputs?: { name: string; link: number | null }[];
  graph?: UpstreamGraphLike | null;
}

interface LmLoraEntry {
  name?: string;
  // LM stores strengths as numbers on add but strings after its arrow
  // controls (toFixed) — accept both.
  strength?: number | string;
  active?: boolean;
}

function entryStrength(entry: LmLoraEntry): number {
  const parsed = typeof entry.strength === "string" ? Number(entry.strength) : entry.strength;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 1;
}

// The live widget value is a plain array; the {__value__:[...]} wrapper only
// exists in serialized prompts. Anything else isn't LM's panel — a widget
// merely NAMED "loras" must not swallow the string fallback.
function panelEntries(value: string | number | boolean | object | undefined): LmLoraEntry[] | null {
  if (typeof value !== "object" || value === null) return null;
  const wrapped = (value as { __value__?: LmLoraEntry[] }).__value__;
  if (Array.isArray(wrapped)) return wrapped;
  return Array.isArray(value) ? (value as LmLoraEntry[]) : null;
}

// LM's loras panel is the run-time authority: at execution the loader loads
// only entries whose `active` toggle is on (missing flag = off, matching its
// python's `lora.get("active", False)`), while its synced tag-text widget
// keeps disabled tags so re-enabling is non-destructive. So when the producer
// has a panel, synthesize from it — even when every entry is toggled off,
// which must preview as "" (no loras), not fall back to the stale text. The
// plain lora-tag string scan only covers producers without a panel.
//
// Returns null when the producer can't be read at all (no link, no panel, no
// tag text) — the caller falls back to the last run's rows. "" is a REAL
// answer: the panel says zero active loras.
export function upstreamLoadedLoras(node: UpstreamHostLike): string | null {
  const linkId = node.inputs?.find((input) => input.name === "loaded_loras")?.link;
  const graph = node.graph;
  if (linkId === null || linkId === undefined || graph?.getNodeById === undefined) return null;
  const links = graph.links;
  const link =
    links === undefined ? undefined : links instanceof Map ? links.get(linkId) : links[linkId];
  if (link === undefined) return null;
  const widgets = graph.getNodeById(link.origin_id)?.widgets ?? [];
  for (const widget of widgets) {
    if (widget.name !== "loras") continue;
    const entries = panelEntries(widget.value);
    if (entries === null) continue;
    return entries
      .filter(
        (entry) =>
          entry.active === true && typeof entry.name === "string" && entry.name.length > 0,
      )
      .map((entry) => `<lora:${entry.name}:${entryStrength(entry)}>`)
      .join(" ");
  }
  for (const widget of widgets) {
    if (typeof widget.value === "string" && widget.value.includes("<lora:")) {
      return widget.value;
    }
  }
  return null;
}

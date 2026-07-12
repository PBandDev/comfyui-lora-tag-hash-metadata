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

function lmLoraEntries(value: string | number | boolean | object | undefined): LmLoraEntry[] {
  if (typeof value !== "object" || value === null) return [];
  const wrapped = (value as { __value__?: LmLoraEntry[] }).__value__;
  if (Array.isArray(wrapped)) return wrapped;
  return Array.isArray(value) ? (value as LmLoraEntry[]) : [];
}

// LM's loras panel is the run-time authority: at execution the loader loads
// only entries whose `active` toggle is on, while its synced tag-text widget
// keeps disabled tags (so re-enabling is non-destructive). So when the
// producer has a panel, synthesize from it — even when every entry is toggled
// off, which must preview as no loras, not fall back to the stale text. The
// plain lora-tag string scan only covers producers without a panel.
export function upstreamLoadedLoras(node: UpstreamHostLike): string {
  const linkId = node.inputs?.find((input) => input.name === "loaded_loras")?.link;
  const graph = node.graph;
  if (linkId === null || linkId === undefined || graph?.getNodeById === undefined) return "";
  const links = graph.links;
  const link =
    links === undefined ? undefined : links instanceof Map ? links.get(linkId) : links[linkId];
  if (link === undefined) return "";
  const widgets = graph.getNodeById(link.origin_id)?.widgets ?? [];
  const panel = widgets.find(
    (widget) => widget.name === "loras" && typeof widget.value === "object" && widget.value !== null,
  );
  if (panel !== undefined) {
    return lmLoraEntries(panel.value)
      .filter(
        (entry) =>
          entry.active !== false && typeof entry.name === "string" && entry.name.length > 0,
      )
      .map((entry) => `<lora:${entry.name}:${entryStrength(entry)}>`)
      .join(" ");
  }
  for (const widget of widgets) {
    if (typeof widget.value === "string" && widget.value.includes("<lora:")) {
      return widget.value;
    }
  }
  return "";
}

export interface ResourceEntry {
  kind: string;
  status: "resolved" | "missing" | "duplicate";
  source?: string;
  name?: string | null;
  type?: string | null;
  hash?: string | null;
  model_id?: number | null;
  version_id?: number | null;
  version_name?: string | null;
  weight?: number | null;
  unverified?: boolean;
  warning?: string | null;
  thumbnail?: string | null;
  error?: string | null;
}

export interface StatusListOptions {
  onImageLoad?: () => void;
}

const STATUSES: ReadonlyArray<ResourceEntry["status"]> = ["resolved", "missing", "duplicate"];
const STYLE_ID = "clth-status-styles-v1";

const STATUS_STYLES = `
.clth-host{
  width:100%;box-sizing:border-box;overflow-y:auto;border-radius:6px;
}
.clth-host::-webkit-scrollbar{width:5px}
.clth-host::-webkit-scrollbar-track{background:transparent}
.clth-host::-webkit-scrollbar-thumb{background:var(--border-color,#4e4e4e);border-radius:3px}
.clth-host::-webkit-scrollbar-thumb:hover{background:var(--p-primary-color,#7aa2f7)}
.civitai-status-list{
  --clth-ok:#9ece6a;--clth-dup:#e0af68;--clth-err:#f7768e;
  display:flex;flex-direction:column;gap:3px;
  box-sizing:border-box;
  padding:6px;border-radius:6px;
  background:var(--comfy-input-bg,#1c1c1c);
  font-size:11px;line-height:1.4;font-family:inherit;
}
.clth-row{
  display:flex;align-items:center;gap:8px;flex:0 0 auto;
  padding:5px 7px;border-radius:5px;
  background:var(--comfy-menu-bg,#2a2a2a);
  border:1px solid transparent;border-left:3px solid var(--border-color,#4e4e4e);
}
.clth-row:hover{background:color-mix(in srgb,var(--fg-color,#fff) 6%,var(--comfy-menu-bg,#2a2a2a))}
.clth-row[data-status="resolved"]{border-left-color:var(--clth-ok)}
.clth-row[data-status="duplicate"]{border-left-color:var(--clth-dup)}
.clth-row[data-status="missing"]{border-left-color:var(--clth-err)}
.clth-thumb{
  position:relative;flex:0 0 auto;width:40px;height:40px;
  border-radius:4px;overflow:hidden;
  border:1px solid var(--border-color,#4e4e4e);
  background:repeating-conic-gradient(#333 0 25%,#222 0 50%) 50%/10px 10px;
  display:flex;align-items:center;justify-content:center;
}
.clth-thumb-glyph{
  color:var(--descrip-text,#999);font-size:14px;font-weight:700;user-select:none;
}
.clth-thumb img{
  position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;
}
.clth-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.clth-name{
  color:var(--fg-color,#fff);font-weight:600;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;
}
.clth-name a{color:inherit;text-decoration:none}
.clth-name a:hover{color:var(--p-primary-color,#7aa2f7);text-decoration:underline}
.clth-sub{
  color:var(--descrip-text,#999);font-size:10px;
  overflow:hidden;text-overflow:ellipsis;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
}
.clth-row[data-status="missing"] .clth-sub{color:var(--clth-err)}
.clth-row[data-status="duplicate"] .clth-sub{color:var(--clth-dup)}
.clth-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%}
.clth-row[data-status="resolved"] .clth-dot{background:var(--clth-ok)}
.clth-row[data-status="duplicate"] .clth-dot{background:var(--clth-dup)}
.clth-row[data-status="missing"] .clth-dot{background:var(--clth-err)}
.clth-empty{
  color:var(--descrip-text,#999);font-size:11px;
  padding:14px 8px;text-align:center;
}
`;

function injectStatusStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STATUS_STYLES;
  document.head.appendChild(style);
}

function isResourceEntry(value: object): value is ResourceEntry {
  const record = value as Record<string, string | number | boolean | null | undefined>;
  return (
    typeof record.kind === "string" &&
    typeof record.status === "string" &&
    (STATUSES as readonly string[]).includes(record.status)
  );
}

export function parseStatusPayload(json: string): ResourceEntry[] {
  try {
    const parsed: object = JSON.parse(json) as object;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ResourceEntry =>
        typeof item === "object" && item !== null && isResourceEntry(item),
    );
  } catch {
    return [];
  }
}

function civitaiUrl(entry: ResourceEntry): string | null {
  if (entry.model_id === null || entry.model_id === undefined) return null;
  const base = `https://civitai.com/models/${entry.model_id}`;
  return entry.version_id === null || entry.version_id === undefined
    ? base
    : `${base}?modelVersionId=${entry.version_id}`;
}

function typeGlyph(entry: ResourceEntry): string {
  const type = (entry.type ?? "").trim();
  if (type.length > 0 && type !== "Unknown") {
    return type[0].toUpperCase();
  }
  return entry.kind === "lora" ? "L" : "?";
}

function buildThumb(entry: ResourceEntry, options: StatusListOptions): HTMLDivElement {
  const thumb = document.createElement("div");
  thumb.className = "clth-thumb";
  const glyph = document.createElement("span");
  glyph.className = "clth-thumb-glyph";
  glyph.textContent = typeGlyph(entry);
  thumb.appendChild(glyph);
  if (entry.thumbnail) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("load", () => {
      options.onImageLoad?.();
    });
    image.addEventListener("error", () => {
      image.remove();
    });
    image.src = entry.thumbnail;
    thumb.appendChild(image);
  }
  return thumb;
}

function subtitleText(entry: ResourceEntry): string {
  const parts: string[] = [];
  if (entry.type) {
    parts.push(entry.version_name ? `${entry.type} · ${entry.version_name}` : entry.type);
  } else if (entry.version_name) {
    parts.push(entry.version_name);
  }
  if (entry.weight !== null && entry.weight !== undefined) {
    parts.push(`×${entry.weight}`);
  }
  if (entry.status === "duplicate") {
    parts.push("duplicate");
  }
  if (entry.unverified) {
    parts.push("unverified");
  }
  if (entry.warning) {
    parts.push(`⚠ ${entry.warning}`);
  }
  if (entry.status === "missing") {
    parts.push(entry.error ?? "failed");
  }
  return parts.join("  ·  ");
}

function buildRow(entry: ResourceEntry, options: StatusListOptions): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "clth-row";
  row.dataset.status = entry.status;

  row.appendChild(buildThumb(entry, options));

  const body = document.createElement("div");
  body.className = "clth-body";

  const name = document.createElement("div");
  name.className = "clth-name";
  const title = entry.name ?? entry.hash ?? entry.source ?? "(unnamed)";
  const url = entry.status === "missing" ? null : civitaiUrl(entry);
  if (url !== null) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = title;
    name.appendChild(link);
  } else {
    name.textContent = title;
  }
  body.appendChild(name);

  const sub = document.createElement("div");
  sub.className = "clth-sub";
  sub.textContent = subtitleText(entry);
  sub.title = entry.status === "missing" ? (entry.error ?? "") : (entry.source ?? "");
  body.appendChild(sub);

  row.appendChild(body);

  const dot = document.createElement("div");
  dot.className = "clth-dot";
  row.appendChild(dot);

  return row;
}

export function buildStatusList(
  entries: ResourceEntry[],
  options: StatusListOptions = {},
): HTMLDivElement {
  injectStatusStyles();
  const root = document.createElement("div");
  root.className = "civitai-status-list";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "clth-empty";
    empty.textContent = "No resources resolved yet — queue a prompt.";
    root.appendChild(empty);
    return root;
  }
  for (const entry of entries) {
    root.appendChild(buildRow(entry, options));
  }
  return root;
}

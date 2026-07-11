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
  error?: string | null;
}

const STATUSES: ReadonlyArray<ResourceEntry["status"]> = ["resolved", "missing", "duplicate"];

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

function rowLabel(entry: ResourceEntry): string {
  const title = entry.name ?? entry.hash ?? entry.source ?? "(unnamed)";
  const typePart = entry.type
    ? ` (${entry.type}${entry.version_name ? ` · ${entry.version_name}` : ""})`
    : "";
  const weightPart =
    entry.weight === null || entry.weight === undefined ? "" : ` ×${entry.weight}`;
  const unverifiedPart = entry.unverified ? " — unverified" : "";
  const duplicatePart = entry.status === "duplicate" ? " — duplicate" : "";
  return `${title}${typePart}${weightPart}${unverifiedPart}${duplicatePart}`;
}

export function buildStatusList(entries: ResourceEntry[]): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "civitai-status-list";
  root.style.cssText =
    "display:flex;flex-direction:column;gap:2px;font-size:11px;line-height:1.4;" +
    "overflow-y:auto;max-height:200px;padding:4px;font-family:inherit;";
  if (entries.length === 0) {
    root.textContent = "No resources resolved yet — queue a prompt.";
    root.style.opacity = "0.6";
    return root;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.dataset.status = entry.status;
    const ok = entry.status === "resolved";
    const dup = entry.status === "duplicate";
    const color = ok ? "#9ece6a" : dup ? "#e0af68" : "#f7768e";
    row.style.cssText = `display:flex;gap:6px;align-items:baseline;color:${color};`;
    const icon = document.createElement("span");
    icon.textContent = ok ? "✓" : dup ? "≡" : "✗";
    icon.style.flex = "0 0 auto";
    row.appendChild(icon);
    const body = document.createElement("span");
    body.style.cssText = "color:inherit;word-break:break-all;min-width:0;";
    if (ok || dup) {
      const url = civitaiUrl(entry);
      const label = rowLabel(entry);
      if (url !== null) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = label;
        link.style.cssText = "color:inherit;text-decoration:underline;";
        body.appendChild(link);
      } else {
        body.textContent = label;
      }
    } else {
      body.textContent = `${entry.source ?? entry.name ?? "(unnamed)"} — ${entry.error ?? "failed"}`;
    }
    row.appendChild(body);
    root.appendChild(row);
  }
  return root;
}

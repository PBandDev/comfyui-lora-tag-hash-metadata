// Body-mounted overlay modal for picking resources. The node's multiline
// textbox stays the single source of truth: Apply replays staged removals
// then appends staged lines onto ctx.getText(), and never reformats the rest.
import {
  type ModelCard,
  SEARCH_SORTS,
  SEARCH_TYPES,
  type SearchQuery,
  type SearchSort,
  type SearchType,
  searchModels,
  typeAcceptsWeight,
} from "./civitaiSearch";
import { type LocalLora, lmAvailable, searchLocalLoras } from "./lmLocal";
import {
  appendLines,
  identitiesIn,
  lineFor,
  removeHashLine,
  removeVersionLine,
} from "./pickerLines";

export interface PickerContext {
  getText(): string;
  setText(value: string): void;
}

type StagedOp =
  | { op: "add-line"; line: string }
  | { op: "remove-version"; versionId: number }
  | { op: "remove-hash"; autov2: string };

const STYLE_ID = "clth-picker-styles-v1";
const DEBOUNCE_MS = 300;

const PICKER_STYLES = `
.clth-pk-overlay{
  position:fixed;inset:0;z-index:11000;
  background:rgba(8,8,8,.6);
  display:flex;align-items:center;justify-content:center;padding:20px;
}
.clth-pk-modal{
  width:min(780px,96vw);max-height:min(640px,90vh);
  display:flex;flex-direction:column;
  background:var(--comfy-menu-bg,#2a2a2a);
  border:1px solid var(--border-color,#4e4e4e);border-radius:10px;
  box-shadow:0 24px 64px rgba(0,0,0,.6);
  color:var(--fg-color,#fff);font-size:12px;line-height:1.45;
}
.clth-pk-head{display:flex;align-items:center;padding:8px 10px 0;border-bottom:1px solid var(--border-color,#4e4e4e)}
.clth-pk-tab{
  background:none;border:0;cursor:pointer;color:var(--descrip-text,#999);
  padding:8px 12px 10px;font-size:12.5px;font-weight:600;
  border-bottom:2px solid transparent;margin-bottom:-1px;font-family:inherit;
}
.clth-pk-tab[aria-selected="true"]{color:var(--fg-color,#fff);border-bottom-color:var(--p-primary-color,#7aa2f7)}
.clth-pk-close{margin-left:auto;background:none;border:0;color:var(--descrip-text,#999);cursor:pointer;font-size:15px;padding:6px 8px}
.clth-pk-tools{display:flex;gap:8px;padding:10px 12px 8px}
.clth-pk-search{
  flex:1;background:var(--comfy-input-bg,#1c1c1c);
  border:1px solid var(--border-color,#4e4e4e);border-radius:6px;
  padding:7px 10px;font-size:12.5px;color:var(--fg-color,#fff);font-family:inherit;
}
.clth-pk-sort{
  background:var(--comfy-input-bg,#1c1c1c);border:1px solid var(--border-color,#4e4e4e);
  border-radius:6px;padding:0 8px;font-size:12px;color:var(--fg-color,#fff);font-family:inherit;
}
.clth-pk-chips{display:flex;gap:5px;padding:0 12px 10px;flex-wrap:wrap}
.clth-pk-chip{
  background:none;border:1px solid var(--border-color,#4e4e4e);border-radius:999px;
  cursor:pointer;color:var(--descrip-text,#999);font-size:11px;padding:3px 11px;font-family:inherit;
}
.clth-pk-chip[aria-pressed="true"]{border-color:var(--p-primary-color,#7aa2f7);color:var(--p-primary-color,#7aa2f7)}
.clth-pk-body{flex:1;overflow-y:auto;padding:2px 12px 12px}
.clth-pk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:7px}
.clth-pk-note{
  margin:0 0 8px;padding:6px 10px;border-radius:6px;font-size:11px;
  color:var(--descrip-text,#999);border:1px solid var(--border-color,#4e4e4e);
}
.clth-pk-card{
  display:flex;gap:9px;padding:8px;border-radius:8px;
  background:var(--comfy-input-bg,#1c1c1c);border:1px solid transparent;
}
.clth-pk-card[data-staged="true"]{border-color:var(--p-primary-color,#7aa2f7)}
.clth-pk-thumb{
  position:relative;flex:none;width:58px;height:58px;border-radius:4px;overflow:hidden;
  border:1px solid var(--border-color,#4e4e4e);
  background:repeating-conic-gradient(#333 0 25%,#222 0 50%) 50%/10px 10px;
  display:flex;align-items:center;justify-content:center;
}
.clth-pk-thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.clth-pk-glyph{color:var(--descrip-text,#999);font-size:15px;font-weight:700;user-select:none}
.clth-pk-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.clth-pk-name{
  font-weight:600;font-size:12px;line-height:1.3;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
.clth-pk-meta{font-size:10.5px;color:var(--descrip-text,#999);display:flex;gap:8px;flex-wrap:wrap}
.clth-pk-innode{
  color:var(--p-primary-color,#7aa2f7);
  border:1px solid var(--p-primary-color,#7aa2f7);border-radius:3px;padding:0 5px;font-size:9.5px;
}
.clth-pk-ctl{display:flex;gap:5px;margin-top:auto}
.clth-pk-versions{
  flex:1;min-width:0;background:var(--comfy-menu-bg,#2a2a2a);
  border:1px solid var(--border-color,#4e4e4e);border-radius:5px;
  color:var(--fg-color,#fff);font-size:10.5px;padding:3px 4px;font-family:inherit;
}
.clth-pk-weight{
  width:46px;flex:none;background:var(--comfy-menu-bg,#2a2a2a);
  border:1px solid var(--border-color,#4e4e4e);border-radius:5px;
  color:var(--fg-color,#fff);font-size:10.5px;padding:3px 4px;text-align:center;font-family:inherit;
}
.clth-pk-add{
  flex:none;cursor:pointer;border-radius:5px;font-size:11px;font-weight:600;
  padding:3px 12px;background:var(--comfy-menu-bg,#2a2a2a);
  border:1px solid var(--border-color,#4e4e4e);color:var(--fg-color,#fff);font-family:inherit;
}
.clth-pk-more{
  margin:10px auto 0;display:block;cursor:pointer;border-radius:6px;font-size:11.5px;
  padding:6px 18px;background:none;border:1px solid var(--border-color,#4e4e4e);
  color:var(--descrip-text,#999);font-family:inherit;
}
.clth-pk-status{color:var(--descrip-text,#999);text-align:center;padding:14px;font-size:11.5px}
.clth-pk-foot{
  display:flex;align-items:center;gap:10px;
  padding:10px 12px;border-top:1px solid var(--border-color,#4e4e4e);
}
.clth-pk-count{font-size:12px;color:var(--descrip-text,#999)}
.clth-pk-cancel{
  margin-left:auto;background:none;border:1px solid var(--border-color,#4e4e4e);
  border-radius:6px;color:var(--descrip-text,#999);cursor:pointer;padding:7px 14px;font-size:12px;font-family:inherit;
}
.clth-pk-apply{
  background:var(--p-primary-color,#7aa2f7);border:1px solid var(--p-primary-color,#7aa2f7);
  border-radius:6px;color:#101318;cursor:pointer;padding:7px 18px;font-size:12px;font-weight:700;font-family:inherit;
}
.clth-pk-apply:disabled{opacity:.35;cursor:default}
`;

function injectPickerStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PICKER_STYLES;
  document.head.appendChild(style);
}

interface ToastCapable {
  extensionManager?: {
    toast?: {
      add(options: { severity: string; summary: string; detail: string; life: number }): void;
    };
  };
}

function toast(detail: string): void {
  const maybeApp = (window as { app?: ToastCapable }).app;
  const add = maybeApp?.extensionManager?.toast?.add;
  if (add !== undefined) {
    add({ severity: "success", summary: "CivitAI", detail, life: 2500 });
    return;
  }
  const banner = document.createElement("div");
  banner.style.cssText =
    "position:fixed;top:60px;right:20px;z-index:99999;padding:9px 14px;border-radius:8px;" +
    "background:var(--comfy-menu-bg,#2a2a2a);color:var(--fg-color,#fff);" +
    "border:1px solid var(--border-color,#4e4e4e);font-size:12px";
  banner.textContent = detail;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 2500);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function thumbEl(src: string | null, glyph: string): HTMLDivElement {
  const thumb = el("div", "clth-pk-thumb");
  thumb.appendChild(el("span", "clth-pk-glyph", glyph));
  if (src !== null) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove());
    image.src = src;
    thumb.appendChild(image);
  }
  return thumb;
}

let active = false;

export function openResourcePicker(ctx: PickerContext): (() => void) | null {
  if (active) return null;
  active = true;
  injectPickerStyles();

  const identities = identitiesIn(ctx.getText());
  const staged = new Map<string, StagedOp>();
  let tab: "civitai" | "local" = "civitai";
  let sort: SearchSort = SEARCH_SORTS[0];
  let typeFilter: SearchType | null = null;
  let cursor: string | null = null;
  let cards: ModelCard[] = [];
  let controller: AbortController | null = null;
  let debounceHandle: ReturnType<typeof setTimeout> | null = null;
  let listenerTimer: ReturnType<typeof setTimeout> | null = null;
  let loadSeq = 0;
  let closed = false;

  const overlay = el("div", "clth-pk-overlay");
  const modal = el("div", "clth-pk-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  overlay.appendChild(modal);

  const head = el("div", "clth-pk-head");
  const tabCivitai = el("button", "clth-pk-tab", "CivitAI search");
  tabCivitai.setAttribute("aria-selected", "true");
  head.appendChild(tabCivitai);
  const closeBtn = el("button", "clth-pk-close", "✕");
  closeBtn.setAttribute("aria-label", "Close");
  head.appendChild(closeBtn);
  modal.appendChild(head);

  const tools = el("div", "clth-pk-tools");
  const search = document.createElement("input");
  search.type = "search";
  search.className = "clth-pk-search";
  search.placeholder = "Search civitai — models, workflows, encoders…";
  tools.appendChild(search);
  const sortSelect = document.createElement("select");
  sortSelect.className = "clth-pk-sort";
  for (const value of SEARCH_SORTS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    sortSelect.appendChild(option);
  }
  tools.appendChild(sortSelect);
  modal.appendChild(tools);

  const chips = el("div", "clth-pk-chips");
  modal.appendChild(chips);
  const body = el("div", "clth-pk-body");
  modal.appendChild(body);

  const foot = el("div", "clth-pk-foot");
  const count = el("span", "clth-pk-count", "nothing staged yet");
  const cancel = el("button", "clth-pk-cancel", "Cancel");
  const apply = el("button", "clth-pk-apply", "Apply to node");
  apply.disabled = true;
  foot.append(count, cancel, apply);
  modal.appendChild(foot);

  function renderCount(): void {
    count.textContent = staged.size === 0 ? "nothing staged yet" : `${staged.size} staged`;
    apply.disabled = staged.size === 0;
  }

  function toggleStage(key: string, op: StagedOp): void {
    if (staged.has(key)) staged.delete(key);
    else staged.set(key, op);
    // Duplicate cards can share an identity (same lora in two folders, a
    // version re-listed after load-more) — sync every control bound to key.
    for (const card of body.querySelectorAll<HTMLElement>(".clth-pk-card")) {
      if (card.dataset.key !== key) continue;
      card.setAttribute("data-staged", String(staged.has(key)));
      const cardButton = card.querySelector<HTMLButtonElement>(".clth-pk-add");
      if (cardButton !== null) refreshButton(key, cardButton);
    }
    renderCount();
  }

  function refreshButton(key: string, button: HTMLButtonElement): void {
    const isStaged = staged.has(key);
    const inNode = button.dataset.innode === "true";
    if (inNode) button.textContent = isStaged ? "↩ keep" : "Remove";
    else button.textContent = isStaged ? "✓" : "Add";
  }

  function civitaiCard(model: ModelCard): HTMLDivElement {
    const card = el("div", "clth-pk-card");
    card.appendChild(thumbEl(model.thumbnail, model.type === "Workflows" ? "W" : model.type[0] ?? "?"));
    const info = el("div", "clth-pk-info");
    info.appendChild(el("div", "clth-pk-name", model.name));
    const meta = el("div", "clth-pk-meta");
    meta.appendChild(el("span", "", model.creator));
    meta.appendChild(el("span", "", `⭳ ${model.downloads.toLocaleString("en-US")}`));
    meta.appendChild(el("span", "", model.type));
    const inNodeChip = el("span", "clth-pk-innode", "in node");
    meta.appendChild(inNodeChip);
    info.appendChild(meta);

    const ctl = el("div", "clth-pk-ctl");
    const versions = document.createElement("select");
    versions.className = "clth-pk-versions";
    for (const version of model.versions) {
      const option = document.createElement("option");
      option.value = String(version.id);
      option.textContent =
        version.baseModel.length > 0 ? `${version.name} · ${version.baseModel}` : version.name;
      versions.appendChild(option);
    }
    ctl.appendChild(versions);
    let weight: HTMLInputElement | null = null;
    if (typeAcceptsWeight(model.type)) {
      weight = document.createElement("input");
      weight.className = "clth-pk-weight";
      weight.placeholder = "1.0";
      weight.inputMode = "decimal";
      weight.setAttribute("aria-label", "Weight");
      ctl.appendChild(weight);
    }
    const button = el("button", "clth-pk-add", "Add");
    ctl.appendChild(button);
    info.appendChild(ctl);
    card.appendChild(info);

    const currentVersionId = (): number => Number(versions.value || model.versions[0].id);
    const refresh = (): void => {
      const versionId = currentVersionId();
      const inNode = identities.versionIds.has(versionId);
      // A different version of this model being present is a hint, not a
      // dedup: two versions are legitimately separate credits.
      const otherVersionInNode =
        !inNode && model.versions.some((version) => identities.versionIds.has(version.id));
      button.dataset.innode = String(inNode);
      card.dataset.key = `v:${versionId}`;
      inNodeChip.textContent = inNode ? "in node" : "other version in node";
      inNodeChip.style.display = inNode || otherVersionInNode ? "" : "none";
      card.setAttribute("data-staged", String(staged.has(`v:${versionId}`)));
      refreshButton(`v:${versionId}`, button);
    };
    versions.addEventListener("change", refresh);
    button.addEventListener("click", () => {
      const versionId = currentVersionId();
      const key = `v:${versionId}`;
      if (identities.versionIds.has(versionId)) {
        toggleStage(key, { op: "remove-version", versionId });
        return;
      }
      const raw = weight?.value.trim() ?? "";
      const parsed = raw.length > 0 ? Number(raw) : null;
      const line = lineFor({
        modelId: model.id,
        versionId,
        weight: parsed !== null && Number.isFinite(parsed) ? parsed : null,
      });
      toggleStage(key, { op: "add-line", line });
    });
    refresh();
    return card;
  }

  function localCard(lora: LocalLora): HTMLDivElement {
    const card = el("div", "clth-pk-card");
    card.appendChild(thumbEl(lora.previewUrl, "L"));
    const info = el("div", "clth-pk-info");
    info.appendChild(el("div", "clth-pk-name", lora.displayName));
    const meta = el("div", "clth-pk-meta");
    meta.appendChild(el("span", "", lora.folder.length > 0 ? lora.folder : lora.fileName));
    const autov2 = lora.sha256 !== null ? lora.sha256.slice(0, 10).toUpperCase() : null;
    meta.appendChild(
      el(
        "span",
        "",
        lora.versionId !== null ? `civitai #${lora.modelId ?? "?"}` : `hash ${autov2 ?? "unknown"}`,
      ),
    );
    const inNodeChip = el("span", "clth-pk-innode", "in node");
    meta.appendChild(inNodeChip);
    info.appendChild(meta);

    const ctl = el("div", "clth-pk-ctl");
    const weight = document.createElement("input");
    weight.className = "clth-pk-weight";
    weight.placeholder = "1.0";
    weight.inputMode = "decimal";
    weight.setAttribute("aria-label", "Weight");
    ctl.appendChild(weight);
    const button = el("button", "clth-pk-add", "Add");
    ctl.appendChild(button);
    info.appendChild(ctl);
    card.appendChild(info);

    // Identity mirrors the representation actually present (or to be
    // inserted): a hash match stays a hash op even when LM also knows the
    // version id, so removals always target the line that really exists.
    const linkIds =
      lora.versionId !== null && lora.modelId !== null
        ? { modelId: lora.modelId, versionId: lora.versionId }
        : null;
    const inNodeAsVersion =
      lora.versionId !== null && identities.versionIds.has(lora.versionId);
    const inNodeAsHash =
      !inNodeAsVersion && autov2 !== null && identities.hashes.has(autov2);
    const inNode = inNodeAsVersion || inNodeAsHash;
    const key = inNodeAsVersion
      ? `v:${lora.versionId}`
      : inNodeAsHash
        ? `h:${autov2}`
        : linkIds !== null
          ? `v:${linkIds.versionId}`
          : autov2 !== null
            ? `h:${autov2}`
            : null;
    button.dataset.innode = String(inNode);
    inNodeChip.style.display = inNode ? "" : "none";
    if (key === null) {
      button.disabled = true;
      button.textContent = "no hash";
      return card;
    }
    card.dataset.key = key;
    button.addEventListener("click", () => {
      if (inNodeAsVersion && lora.versionId !== null) {
        toggleStage(key, { op: "remove-version", versionId: lora.versionId });
        return;
      }
      if (inNodeAsHash && autov2 !== null) {
        toggleStage(key, { op: "remove-hash", autov2 });
        return;
      }
      const raw = weight.value.trim();
      const parsed = raw.length > 0 ? Number(raw) : null;
      const finite = parsed !== null && Number.isFinite(parsed) ? parsed : null;
      const line =
        linkIds !== null
          ? lineFor({ modelId: linkIds.modelId, versionId: linkIds.versionId, weight: finite })
          : autov2 !== null
            ? `${autov2}${finite !== null ? ` ${finite}` : ""}`
            : null;
      if (line === null) return;
      toggleStage(key, { op: "add-line", line });
    });
    refreshButton(key, button);
    card.setAttribute("data-staged", String(staged.has(key)));
    return card;
  }

  function renderChips(): void {
    chips.replaceChildren();
    if (tab !== "civitai") return;
    const all = el("button", "clth-pk-chip", "All");
    all.setAttribute("aria-pressed", String(typeFilter === null));
    all.addEventListener("click", () => {
      typeFilter = null;
      renderChips();
      void load(true);
    });
    chips.appendChild(all);
    for (const value of SEARCH_TYPES) {
      const chip = el("button", "clth-pk-chip", value);
      chip.setAttribute("aria-pressed", String(typeFilter === value));
      chip.addEventListener("click", () => {
        typeFilter = value;
        renderChips();
        void load(true);
      });
      chips.appendChild(chip);
    }
  }

  function grid(): HTMLDivElement {
    const existing = body.querySelector<HTMLDivElement>(".clth-pk-grid");
    if (existing !== null) return existing;
    const created = el("div", "clth-pk-grid");
    body.appendChild(created);
    return created;
  }

  function setStatus(message: string | null): void {
    body.querySelector(".clth-pk-status")?.remove();
    if (message !== null) body.appendChild(el("div", "clth-pk-status", message));
  }

  async function load(reset: boolean): Promise<void> {
    // An explicit load supersedes any pending debounced one and any in-flight
    // request; the sequence number drops stale continuations that resolved
    // before the abort landed.
    if (debounceHandle !== null) {
      clearTimeout(debounceHandle);
      debounceHandle = null;
    }
    const seq = ++loadSeq;
    controller?.abort();
    controller = new AbortController();
    if (reset) {
      cursor = null;
      cards = [];
      body.replaceChildren();
    }
    setStatus("Loading…");
    try {
      if (tab === "civitai") {
        const query: SearchQuery = { sort, limit: 20 };
        const text = search.value.trim();
        if (text.length >= 2) query.query = text;
        if (typeFilter !== null) query.type = typeFilter;
        if (cursor !== null) query.cursor = cursor;
        const page = await searchModels(query, controller.signal);
        if (seq !== loadSeq || closed) return;
        cursor = page.nextCursor;
        cards = cards.concat(page.items);
        setStatus(null);
        const target = grid();
        for (const model of page.items) target.appendChild(civitaiCard(model));
        body.querySelector(".clth-pk-more")?.remove();
        if (cursor !== null) {
          const more = el("button", "clth-pk-more", "Load more");
          more.addEventListener("click", () => void load(false));
          body.appendChild(more);
        }
        if (cards.length === 0) setStatus("No results.");
      } else {
        const rows = await searchLocalLoras(search.value.trim(), controller.signal);
        if (seq !== loadSeq || closed) return;
        setStatus(null);
        body.replaceChildren();
        const note = el(
          "div",
          "clth-pk-note",
          "Local files via LoRA Manager. Matched loras insert a civitai link; unmatched ones insert their hash.",
        );
        body.appendChild(note);
        const target = el("div", "clth-pk-grid");
        body.appendChild(target);
        for (const lora of rows) target.appendChild(localCard(lora));
        if (rows.length === 0) setStatus("No local loras found.");
      }
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return;
      setStatus(`Search failed: ${(error as Error).message}`);
    }
  }

  function selectTab(next: "civitai" | "local", localTab: HTMLButtonElement | null): void {
    tab = next;
    tabCivitai.setAttribute("aria-selected", String(next === "civitai"));
    localTab?.setAttribute("aria-selected", String(next === "local"));
    search.placeholder =
      next === "civitai" ? "Search civitai — models, workflows, encoders…" : "Filter local loras…";
    renderChips();
    void load(true);
  }

  function applyStaged(): void {
    let value = ctx.getText();
    const additions: string[] = [];
    for (const op of staged.values()) {
      if (op.op === "remove-version") value = removeVersionLine(value, op.versionId);
      else if (op.op === "remove-hash") value = removeHashLine(value, op.autov2);
      else additions.push(op.line);
    }
    if (additions.length > 0) value = appendLines(value, additions);
    ctx.setText(value);
    toast(
      additions.length > 0
        ? `Added ${additions.length} resource${additions.length === 1 ? "" : "s"}`
        : "Updated resources",
    );
    close();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (!overlay.contains(event.target as Node)) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.stopImmediatePropagation();
      if (staged.size > 0) applyStaged();
      return;
    }
    // Keep ComfyUI/LiteGraph shortcuts (Q, Delete, …) from firing while
    // typing. stopImmediatePropagation also silences other document-level
    // capture listeners, not just deeper targets.
    event.stopImmediatePropagation();
  }
  function onPointerDown(event: PointerEvent | MouseEvent): void {
    if (overlay.contains(event.target as Node)) event.stopPropagation();
  }

  function close(): void {
    if (closed) return; // idempotent — a stale closer must never touch a newer picker
    closed = true;
    controller?.abort();
    if (debounceHandle !== null) clearTimeout(debounceHandle);
    if (listenerTimer !== null) clearTimeout(listenerTimer);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("mousedown", onPointerDown, true);
    overlay.remove();
    active = false;
  }

  closeBtn.addEventListener("click", close);
  cancel.addEventListener("click", close);
  apply.addEventListener("click", applyStaged);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  tabCivitai.addEventListener("click", () => selectTab("civitai", localTabButton));
  search.addEventListener("input", () => {
    if (debounceHandle !== null) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(() => void load(true), DEBOUNCE_MS);
  });
  sortSelect.addEventListener("change", () => {
    sort = sortSelect.value as SearchSort;
    void load(true);
  });

  // Attach capture listeners after the opening click has fully propagated.
  listenerTimer = setTimeout(() => {
    listenerTimer = null;
    if (closed) return; // opened and closed within the same tick
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
  }, 0);

  let localTabButton: HTMLButtonElement | null = null;
  void lmAvailable().then((available) => {
    if (!available || closed) return;
    localTabButton = el("button", "clth-pk-tab clth-pk-tab-local", "Local · LoRA Manager");
    localTabButton.setAttribute("aria-selected", "false");
    localTabButton.addEventListener("click", () => selectTab("local", localTabButton));
    head.insertBefore(localTabButton, closeBtn);
  });

  document.body.appendChild(overlay);
  renderChips();
  renderCount();
  void load(true);
  search.focus();
  return close;
}

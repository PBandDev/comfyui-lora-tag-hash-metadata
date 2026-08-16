import type { ComfyApp } from "@comfyorg/comfyui-frontend-types";
import { SETTINGS_IDS } from "./constants";
import { openResourcePicker } from "./picker";
import { removeRawLine } from "./pickerLines";
import { fetchPreview } from "./preview";
import {
  buildStatusList,
  parseStatusPayload,
  type ResourceEntry,
  type StatusListOptions,
} from "./statusList";
import { upstreamLoadedLoras, type UpstreamGraphLike } from "./upstreamLoras";

declare global {
  const app: ComfyApp;

  interface Window {
    app: ComfyApp;
  }
}

const V2_NODE_ID = "CivitaiResourcesToHashMetadata";
const WIDGET_NAME = "civitai_status";
// The frontend insets a DOM widget's element 10px on each side of its layout
// slot, so every height here pays this overhead on top of the visible px.
const DOM_WIDGET_INSET = 20;
// One visible status row: 40px thumb + 2*5px row padding + 2*1px border +
// 2*6px list padding. The list reserves exactly this much, so the node's
// default height shows a single row; extra node height all flows here (no
// maxHeight = the only flexible widget), and overflow scrolls inside the host.
const STATUS_MIN_HEIGHT = 64 + DOM_WIDGET_INSET;
// The core textarea is otherwise the second flexible widget and would eat
// half of every resize — pin it at 4 lines (10px font, ~12px/line + padding).
const TEXTAREA_HEIGHT = 52 + DOM_WIDGET_INSET;

interface StatusMessage {
  civitai_resources_status?: string[];
  civitai_resources_input?: string[];
}

interface TextWidgetLike {
  name: string;
  value?: string | number | boolean | object;
  callback?: (value: string) => void;
  options?: {
    getMinHeight?: () => number;
    getMaxHeight?: () => number;
  };
}

interface StatusNodeLike {
  widgets?: TextWidgetLike[];
  inputs?: { name: string; link: number | null }[];
  graph?: UpstreamGraphLike | null;
  addWidget?(
    type: "button",
    name: string,
    value: string,
    callback: () => void,
    options: { serialize: boolean },
  ): (TextWidgetLike & { serialize?: boolean }) | undefined;
  addDOMWidget?(
    name: string,
    type: string,
    element: HTMLElement,
    options: {
      serialize: boolean;
      hideOnZoom: boolean;
      getMinHeight: () => number;
    },
  ): { serialize?: boolean } | undefined;
  setDirtyCanvas?(foreground: boolean, background: boolean): void;
  onNodeCreated?(): void;
  onExecuted?(message: StatusMessage): void;
  onRemoved?(): void;
  onConfigure?(info: object): void;
}

const statusHosts = new WeakMap<StatusNodeLike, HTMLDivElement>();
const pickerClosers = new WeakMap<StatusNodeLike, () => void>();
const previewSeqs = new WeakMap<StatusNodeLike, number>();
const previewControllers = new WeakMap<StatusNodeLike, AbortController>();
const configureTimers = new WeakMap<StatusNodeLike, ReturnType<typeof setTimeout>>();
// loaded_loras rows from the node's last run — previews can't know that input
// (it only exists at execution time), so keep showing what the run reported.
const lastLoraEntries = new WeakMap<StatusNodeLike, ResourceEntry[]>();

function resourceTextWidget(node: StatusNodeLike): TextWidgetLike | undefined {
  return node.widgets?.find((widget) => widget.name === "civitai_resources");
}

function setResourceText(node: StatusNodeLike, value: string): void {
  const widget = resourceTextWidget(node);
  if (widget === undefined) return;
  widget.value = value;
  widget.callback?.(value);
  node.setDirtyCanvas?.(true, true);
}

function statusOptionsFor(node: StatusNodeLike): StatusListOptions {
  return {
    onImageLoad: () => node.setDirtyCanvas?.(true, true),
    onRemove: (entry) => {
      const widget = resourceTextWidget(node);
      if (widget === undefined || typeof entry.source !== "string") return;
      setResourceText(node, removeRawLine(String(widget.value ?? ""), entry.source));
      void refreshPreview(node);
    },
  };
}

// Re-render the status list from the textbox via the pack's /clth/preview
// route — same resolver+cache as a run, so picker applies, row removals, and
// workflow loads show live rows without queueing a prompt.
async function refreshPreview(node: StatusNodeLike): Promise<void> {
  const widget = resourceTextWidget(node);
  const host = statusHostFor(node);
  if (widget === undefined || host === null) return;
  const seq = (previewSeqs.get(node) ?? 0) + 1;
  previewSeqs.set(node, seq);
  previewControllers.get(node)?.abort();
  const controller = new AbortController();
  previewControllers.set(node, controller);
  const text = String(widget.value ?? "");
  // Live upstream widget state beats the last-run snapshot; the snapshot
  // only covers producers we can't read without executing (null). "" is an
  // authoritative zero — an all-disabled panel must not resurrect old rows.
  const upstream = upstreamLoadedLoras(node);
  const loraEntries = upstream === null ? (lastLoraEntries.get(node) ?? []) : [];
  const loraHashes = loraEntries
    .map((entry) => (typeof entry.hash === "string" ? entry.hash : ""))
    .filter((hash) => hash.length > 0);
  if (text.trim().length === 0 && (upstream === null || upstream.length === 0)) {
    host.replaceChildren(
      buildStatusList(loraEntries, {
        ...statusOptionsFor(node),
        ...(loraEntries.length > 0
          ? { note: "queue a prompt to see final resource list" }
          : {}),
      }),
    );
    return;
  }
  try {
    const entries = await fetchPreview(text, loraHashes, upstream ?? "", controller.signal);
    if (previewSeqs.get(node) !== seq) return;
    host.replaceChildren(
      buildStatusList([...loraEntries, ...entries], {
        ...statusOptionsFor(node),
        note: "queue a prompt to see final resource list",
      }),
    );
  } catch {
    // Preview is best-effort (server restarting, offline) — keep whatever the
    // list currently shows rather than flashing an error state.
  }
}

function createStatusHost(node: StatusNodeLike): HTMLDivElement | null {
  if (typeof node.addDOMWidget !== "function") {
    return null;
  }
  const host = document.createElement("div");
  host.className = "clth-host";
  host.dataset.widget = WIDGET_NAME;
  const widget = node.addDOMWidget(WIDGET_NAME, "div", host, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => STATUS_MIN_HEIGHT,
  });
  if (widget !== undefined) {
    widget.serialize = false;
  }
  host.replaceChildren(buildStatusList([], statusOptionsFor(node)));
  statusHosts.set(node, host);
  return host;
}

function createPickerButton(node: StatusNodeLike): void {
  const textWidget = node.widgets?.find((widget) => widget.name === "civitai_resources");
  if (textWidget === undefined || typeof node.addWidget !== "function") {
    return;
  }
  const button = node.addWidget(
    "button",
    "＋ Add Resource",
    "",
    () => {
      const close = openResourcePicker({
        getText: () => String(textWidget.value ?? ""),
        setText: (value) => {
          setResourceText(node, value);
          void refreshPreview(node);
        },
      });
      // null = a picker is already open; never overwrite the live closer.
      if (close !== null) {
        pickerClosers.set(node, close);
      }
    },
    { serialize: false },
  );
  // The options flag alone doesn't keep the button out of widgets_values —
  // mirror the existing DOM-widget pattern and pin it on the widget too.
  if (button !== undefined) {
    button.serialize = false;
  }
}

function createRefreshButton(node: StatusNodeLike): void {
  if (typeof node.addWidget !== "function") {
    return;
  }
  // Lives outside the scrolling list so it never needs scrolling to reach.
  const button = node.addWidget(
    "button",
    "⟳ Refresh resources",
    "",
    () => void refreshPreview(node),
    { serialize: false },
  );
  if (button !== undefined) {
    button.serialize = false;
  }
}

function statusHostFor(node: StatusNodeLike): HTMLDivElement | null {
  const host = statusHosts.get(node);
  if (host !== undefined && node.widgets?.some((widget) => widget.name === WIDGET_NAME)) {
    return host;
  }
  return createStatusHost(node);
}

// The textbox stays a fixed 4-line strip so a node resize only ever
// grows/shrinks the status list below it.
function pinResourceTextareaHeight(node: StatusNodeLike): void {
  const widget = resourceTextWidget(node);
  if (widget?.options === undefined) return;
  widget.options.getMinHeight = () => TEXTAREA_HEIGHT;
  widget.options.getMaxHeight = () => TEXTAREA_HEIGHT;
}

app.registerExtension({
  name: "ComfyUI LoRA Tag Hash Metadata",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== V2_NODE_ID) {
      return;
    }
    const proto = nodeType.prototype as StatusNodeLike;
    const originalCreated = proto.onNodeCreated;
    proto.onNodeCreated = function (this: StatusNodeLike) {
      originalCreated?.call(this);
      pinResourceTextareaHeight(this);
      createPickerButton(this);
      createRefreshButton(this);
      createStatusHost(this);
    };
    const originalRemoved = proto.onRemoved;
    proto.onRemoved = function (this: StatusNodeLike) {
      pickerClosers.get(this)?.();
      pickerClosers.delete(this);
      // Kill the deferred configure preview too, or removing a freshly
      // loaded node lets the timer resurrect a request (and DOM widget).
      const timer = configureTimers.get(this);
      if (timer !== undefined) {
        clearTimeout(timer);
        configureTimers.delete(this);
      }
      previewSeqs.set(this, (previewSeqs.get(this) ?? 0) + 1);
      previewControllers.get(this)?.abort();
      originalRemoved?.call(this);
    };
    const originalConfigure = proto.onConfigure;
    proto.onConfigure = function (this: StatusNodeLike, info: object) {
      originalConfigure?.call(this, info);
      // Widget values land during configure — preview on the next tick so a
      // loaded workflow shows its resources without queueing.
      const timer = setTimeout(() => {
        configureTimers.delete(this);
        void refreshPreview(this);
      }, 0);
      configureTimers.set(this, timer);
    };
    const originalExecuted = proto.onExecuted;
    proto.onExecuted = function (this: StatusNodeLike, message: StatusMessage) {
      originalExecuted?.call(this, message);
      const payload = message.civitai_resources_status?.[0] ?? "[]";
      const host = statusHostFor(this);
      if (host === null) {
        return;
      }
      const entries = parseStatusPayload(payload);
      // Remember the run's loaded_loras rows — previews merge them back in
      // (that input only exists at execution time). Even a stale-textbox run
      // still reported the current lora chain.
      lastLoraEntries.set(
        this,
        entries.filter((entry) => entry.kind === "lora"),
      );
      // A run is only authoritative for the textbox it resolved — if the user
      // edited while it was queued, preview the current text instead.
      const executedInput = message.civitai_resources_input?.[0];
      const currentText = String(resourceTextWidget(this)?.value ?? "");
      if (executedInput !== undefined && executedInput !== currentText) {
        void refreshPreview(this);
        return;
      }
      // Executed payload wins over any in-flight preview of the same text.
      previewSeqs.set(this, (previewSeqs.get(this) ?? 0) + 1);
      previewControllers.get(this)?.abort();
      host.replaceChildren(buildStatusList(entries, statusOptionsFor(this)));
    };
  },
  settings: [
    {
      id: SETTINGS_IDS.VERSION,
      name: "Version 2.0.3",
      type: () => {
        const spanEl = document.createElement("span");
        spanEl.insertAdjacentHTML(
          "beforeend",
          `<a href="https://github.com/PBandDev/comfyui-lora-tag-hash-metadata" target="_blank" style="padding-right: 12px;">Homepage</a>`
        );

        return spanEl;
      },
      defaultValue: undefined,
    },
    {
      id: SETTINGS_IDS.DEBUG_LOGGING,
      name: "Enable Debug Logging",
      type: "boolean",
      tooltip:
        "Show detailed debug logs in browser console during operation",
      defaultValue: false,
    },
  ]
});

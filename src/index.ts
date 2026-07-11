import type { ComfyApp } from "@comfyorg/comfyui-frontend-types";
import { SETTINGS_IDS } from "./constants";
import { openResourcePicker } from "./picker";
import { removeRawLine } from "./pickerLines";
import { fetchPreview } from "./preview";
import {
  buildStatusList,
  parseStatusPayload,
  type StatusListOptions,
} from "./statusList";

declare global {
  const app: ComfyApp;

  interface Window {
    app: ComfyApp;
  }
}

const V2_NODE_ID = "CivitaiResourcesToHashMetadata";
const WIDGET_NAME = "civitai_status";
// The node reserves [min,max] px for the widget; content beyond the cap
// scrolls INSIDE the host so it can never overflow the node bounds.
const WIDGET_MIN_HEIGHT = 60;
const WIDGET_MAX_HEIGHT = 320;

interface StatusMessage {
  civitai_resources_status?: string[];
  civitai_resources_input?: string[];
}

interface TextWidgetLike {
  name: string;
  value?: string | number | boolean | object;
  callback?: (value: string) => void;
}

interface StatusNodeLike {
  size?: [number, number];
  widgets?: TextWidgetLike[];
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
      getMaxHeight: () => number;
    },
  ): { serialize?: boolean } | undefined;
  computeSize?(): [number, number];
  setSize?(size: [number, number]): void;
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
    onRefresh: () => void refreshPreview(node),
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
  if (text.trim().length === 0) {
    host.replaceChildren(buildStatusList([], statusOptionsFor(node)));
    syncNodeSize(node);
    return;
  }
  try {
    const entries = await fetchPreview(text, controller.signal);
    if (previewSeqs.get(node) !== seq) return;
    host.replaceChildren(
      buildStatusList(entries, {
        ...statusOptionsFor(node),
        note: "preview — queue a prompt to finalize credits",
      }),
    );
    syncNodeSize(node);
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
  host.style.maxHeight = `${WIDGET_MAX_HEIGHT}px`;
  const widget = node.addDOMWidget(WIDGET_NAME, "div", host, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () =>
      Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, host.scrollHeight)),
    getMaxHeight: () => WIDGET_MAX_HEIGHT,
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

function statusHostFor(node: StatusNodeLike): HTMLDivElement | null {
  const host = statusHosts.get(node);
  if (host !== undefined && node.widgets?.some((widget) => widget.name === WIDGET_NAME)) {
    return host;
  }
  return createStatusHost(node);
}

function syncNodeSize(node: StatusNodeLike): void {
  // Canvas mode auto-grows but never shrinks, and scrollHeight is only valid
  // after layout — recompute on the next frame.
  requestAnimationFrame(() => {
    if (typeof node.computeSize === "function" && typeof node.setSize === "function") {
      const computed = node.computeSize();
      const width = Math.max(node.size?.[0] ?? computed[0], computed[0]);
      node.setSize([width, computed[1]]);
    }
    node.setDirtyCanvas?.(true, true);
  });
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
      createPickerButton(this);
      createStatusHost(this);
      syncNodeSize(this);
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
      host.replaceChildren(buildStatusList(parseStatusPayload(payload), statusOptionsFor(this)));
      syncNodeSize(this);
    };
  },
  settings: [
    {
      id: SETTINGS_IDS.VERSION,
      name: "Version 1.1.0",
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

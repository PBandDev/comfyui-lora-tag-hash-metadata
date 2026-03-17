# ComfyUI LoRA Tag Hash Metadata

ComfyUI custom node that converts `<lora:name:weight>` text into `Name:HASH:Weight`
metadata strings for downstream nodes such as Civitai-aware metadata savers.

Primary use case:

- feed `loaded_loras` from LoRA Manager into `LoRA Tags To Hash Metadata`
- connect `additional_hashes` into `Image Saver Metadata.additional_hashes`
- preserve LoRA hash metadata so downstream nodes can resolve Civitai model info

The node is generic on purpose. Any node that outputs `<lora:name:weight>` text can
feed it, and any downstream node that expects `Name:HASH:Weight` strings can consume
the result.

## Node

- Node id: `LoraTagsToHashMetadata`
- Display name: `LoRA Tags To Hash Metadata`
- Category: `utils/metadata`

Inputs:

- `loaded_loras`: multiline string containing one or more `<lora:name:weight>` tags

Outputs:

- `additional_hashes`: comma-separated `Name:HASH:Weight` string
- `resolved_loras`: comma-separated list of successfully resolved LoRA names
- `missing_loras`: comma-separated list of unresolved or incompatible names

Behavior:

- supports `<lora:name>` and defaults weight to `1.0`
- resolves path-qualified names before basename fallback
- computes SHA256 locally and emits the first 10 uppercase hex characters
- deduplicates repeated tags with last occurrence winning
- reports comma-bearing names in `missing_loras` instead of silently dropping them

## Development

1. Clone/symlink this folder into ComfyUI's `custom_nodes/` directory
2. Run `pnpm install`
3. Run `pnpm dev` to watch for changes and rebuild `dist/`

### Python Test Workflow

Use `uv` for Python-side tooling:

```bash
uv sync
uv run pytest
```

```bash
pnpm install    # Install dependencies
pnpm dev        # Watch mode - rebuilds dist/ on change
pnpm build      # Build for production
pnpm test       # Run tests
```

**Note:** Reload ComfyUI frontend (browser refresh) for JS changes. Restart ComfyUI server for Python changes.

## LoRA Tag Hash Metadata

Typical wiring:

```text
Lora Loader (LoraManager).loaded_loras
  -> LoRA Tags To Hash Metadata.loaded_loras
  -> Image Saver Metadata.additional_hashes
```

You can also feed any other text source that emits the same tag syntax.

## Publishing to ComfyUI Registry

1. Ensure all fields in `pyproject.toml` are correct
2. Add `REGISTRY_ACCESS_TOKEN` secret to your repo (from ComfyUI registry)
3. Go to Actions → "Publish to Comfy registry" → Run workflow
4. Select version bump type (patch/minor/major)

## License

MIT

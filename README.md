# ComfyUI LoRA Tag Hash Metadata

Credit the resources behind your images on CivitAI — automatically. This node
pack resolves the LoRAs you loaded and any other CivitAI resource you list
(workflows, text encoders, detailers, checkpoints, …) to their AutoV2 hashes
and hands them to
[ComfyUI-Image-Saver](https://github.com/alexopus/ComfyUI-Image-Saver), so
every saved image carries the hashes CivitAI uses to link resources.

![Civitai Resources To Hash Metadata wired between LoRA Manager and Image Saver](assets/civitai-resources-node.png)

Typical chain: **Lora Loader (LoraManager)** → **Civitai Resources To Hash
Metadata** → **Image Saver Metadata** → **Image Saver Simple**. The node
credits every lora the loader loaded plus whatever you paste into its
textbox, and shows a live status list so you can see what resolved.

Created with
[comfyui-custom-node-template](https://github.com/PBandDev/comfyui-custom-node-template).

## Install

### ComfyUI Manager

1. Open **Manager** in ComfyUI
2. Click **Install Custom Nodes**
3. Search for `LoRA Tag Hash Metadata` and click **Install**
4. Restart ComfyUI if Manager prompts you to

### Comfy CLI

```bash
comfy node install comfyui-lora-tag-hash-metadata
```

Pairs with [ComfyUI-Lora-Manager](https://github.com/willmiao/ComfyUI-Lora-Manager)
(gives you `loaded_loras`) and
[ComfyUI-Image-Saver](https://github.com/alexopus/ComfyUI-Image-Saver)
(writes the metadata).

## Civitai Resources To Hash Metadata

Category `utils/metadata` · node id `CivitaiResourcesToHashMetadata`

### Inputs

| Input | Connect / type | What it does |
|---|---|---|
| `loaded_loras` (optional link) | `<lora:name:weight>` text, e.g. LoRA Manager's `loaded_loras` | Each lora is found in your `loras` folders and hashed locally |
| `civitai_resources` (textbox) | One CivitAI resource per line — [example below](#example-civitai_resources) | Resolved through the CivitAI API. **＋ Add Resource** searches CivitAI or picks from LoRA Manager's local models so you never hand-copy URLs |

### Outputs

| Output | Wire to | Contents |
|---|---|---|
| `additional_hashes` | Image Saver Metadata → `additional_hashes` | `Name:AUTOV2[:Weight]` list — what CivitAI links on |
| `resolved` / `missing` | optional text display | Names that resolved / lines that failed |
| `resources_json` | optional, your own tooling | Every entry as JSON (status, type, version, hash, links) |
| `lora_hashes` | Image Saver Metadata → `custom` | A1111-style `Lora hashes: "name: HASH, …"` line so tools that only read that key (sd-image-sorter, LoRA Manager recipe import) see your loras too |

### Status list

Every resource shows as a row: thumbnail, name linked to CivitAI, type ·
version, and a colored dot — green resolved, amber duplicate, red failed
(hover for the reason). The list updates live after **＋ Add Resource**,
**⟳ Refresh resources**, or a run; a row's **✕** deletes its line.

### Good to know

- Lookups are cached on disk — repeat runs are instant and work offline.
- A bad line never stops your queue; it lands in `missing` and the list.
- Keep Image Saver's `download_civitai_data` **True** (the default). With it
  off, Image Saver silently drops weighted entries.
- Already typing into Image Saver's `custom`? Join your text and
  `lora_hashes` with `, `.

## Example `civitai_resources`

```text
# civitai model URLs (.com / .red / .green) — pin a version with ?modelVersionId=…
https://civitai.com/models/2767064/anima-detailer?modelVersionId=3114726 0.8
https://civitai.red/models/1362968/workflow-for-anima-and-sdxl-noobai-xlillustrious-xl
# AutoV2 or SHA256 hash
CD64AF8696
# AIR URN
urn:air:anima:lora:civitai:2767064@3114726
```

A trailing weight (`0.8`), `#` comments and blank lines are all fine. Bare
numeric IDs are rejected because they are ambiguous.

## LoRA Tags To Hash Metadata (v1, deprecated)

The original node (`LoraTagsToHashMetadata`) only turns `<lora:…>` tags into
`Name:HASH:Weight` strings. It still works and has the same `lora_hashes`
output, but new workflows should use **Civitai Resources To Hash Metadata** —
it does everything v1 did and more.

## Development

```bash
pnpm install
pnpm dev     # rebuild dist/ on change (refresh the browser to see JS changes)
pnpm test    # vitest + pytest + full e2e against a repo-local ComfyUI (live civitai API)
```

Harness details and user stories: [docs/TESTING.md](docs/TESTING.md).
Releases go through the **Publish to Comfy registry** GitHub Action.

## License

MIT

# Testing

## Commands

```bash
pnpm test            # everything: frontend + backend + full e2e (live civitai API)
pnpm test:unit       # fast lanes only (vitest + pytest)
pnpm test:e2e        # build dist/, provision .e2e/, run Playwright
pnpm test:frontend   # vitest (jsdom)
pnpm test:backend    # uv run python -m pytest tests/python -q
pnpm setup:e2e       # provision Chromium + ComfyUI + packs + fixtures under .e2e/
pnpm e2e:serve       # foreground ComfyUI on port 8199 for manual testing
```

## One-suite policy

There are no optional, nightly, or manually-triggered test tiers. `pnpm test`
runs the complete suite — including the live-civitai-API e2e — every time,
locally and in CI. If an upstream change (ComfyUI, LoRA Manager, Image Saver,
civitai API) breaks the suite, that is a signal to look into it, not to skip
the test.

## E2E Harness

- ComfyUI is pinned to `v0.18.1` (see `e2e.config.mjs`).
- `comfy-cli` is pinned inside `.e2e/venv`; the ComfyUI server runs from its
  own venv at `.e2e/comfyui/.venv` (pack requirements install there).
- This repo is mounted into `.e2e/comfyui/custom_nodes/comfyui-lora-tag-hash-metadata`.
- Third-party packs are pinned by commit SHA in `tests/e2e/versions.lock.json`
  (ComfyUI-Lora-Manager v1.1.6, ComfyUI-Image-Saver v1.23.0) and installed by
  `scripts/setup-e2e-packs.mjs`.
- Tiny real civitai LoRA fixtures (~6 MB total) are pinned by SHA256 in
  `tests/e2e/fixtures.lock.json`, downloaded on miss into
  `tests/e2e/fixtures/loras/` (gitignored, cached in CI), and COPIED into the
  workspace `models/loras` (LoRA Manager writes `.metadata.json` sidecars next
  to loras — the canonical fixtures dir stays clean).
- `tests/e2e/e2e_test_nodes/` provides `E2EDummyModel`, a checkpoint-free
  MODEL source so `Lora Loader (LoraManager)` can really load loras on CPU.
- LoRA Manager runs with `use_portable_settings: true` so its state stays
  inside the clone and never touches a real LoRA Manager install.
- The harness is CPU-only, listens on `127.0.0.1:8199` (`COMFYUI_E2E_PORT`
  overrides), and never touches a ComfyUI instance running on 8188.

If a pin changes or the scoped install gets stale, delete `.e2e/` and rerun
`pnpm setup:e2e`.

## Manual testing (serve mode)

```bash
pnpm install
pnpm build
pnpm setup:e2e     # first run ~5-10 min (ComfyUI + cpu torch + chromium + 6 MB fixtures)
pnpm e2e:serve     # foreground; Ctrl+C to stop
# open http://127.0.0.1:8199
```

### User stories

1. **HAPPY PATH** — Add "Civitai Resources To Hash Metadata". Paste:
   ```
   https://civitai.red/models/1362968/workflow-for-anima-and-sdxl-noobai-xlillustrious-xl
   https://civitai.red/models/2598886/anima-text-encoder-qwen3-06b-heretic-abliterated-uncensored
   https://civitai.red/models/2767064/anima-detailer?modelVersionId=3114726
   ```
   Queue. EXPECT: 3 green ✓ rows — "…(Workflows · <version>)", "…(Other ·
   fp32…)", "Anima Detailer (LORA · v0_8)" — each a clickable civitai link.
2. **FULL CHAIN** — E2E Dummy Model → Lora Loader (LoraManager) [pick
   fisheye_slider_v10] → v2 node (`loaded_loras`) → Image Saver Metadata
   (`additional_hashes`) + EmptyImage → Image Saver Simple. Queue. EXPECT:
   ✓ row for the lora; saved PNG in `.e2e/comfyui/output/` whose parameters
   text credits it.
3. **FAIL STATES** — Add lines: `https://civitai.com/models/999999999`,
   `not a url`, `2767064`. EXPECT: red ✗ rows with reasons (not found /
   unrecognized / bare IDs rejected); queue COMPLETES; other rows still ✓;
   `missing` output populated.
4. **HASH + AIR** — Lines `CD64AF8696` and
   `urn:air:anima:lora:civitai:2767064@3114726`. EXPECT: both resolve to
   Anima Detailer; second run instant (cache).
5. **WEIGHT** — `https://civitai.com/models/2767064?modelVersionId=3114726 0.8`.
   EXPECT: ✓ row showing ×0.8; `additional_hashes` output ends `:0.8`.
6. **DEDUP** — Same resource via BOTH a lora tag path and URL/hash. EXPECT:
   one emitted entry (lora wins), the URL row marked ≡ duplicate.
7. **OFFLINE** — Disconnect network; re-queue story 1 (cached → still ✓).
   Add a NEW unpinned model URL. EXPECT: ✗ "civitai api unreachable",
   nothing crashes.
8. **COMMENTS** — `# ignored` lines and blanks. EXPECT: no rows, no errors.
9. **V1 REGRESSION** — Old "LoRA Tags To Hash Metadata" node still works
   identically.
10. **LOOK & FEEL** — row density, colors, link affordance, overflow behavior
    on 20+ lines.
11. **Picker**: click ＋ Add Resource → browse feed appears → search "anima
    detailer" → Add → Apply → a pinned URL line lands in the textbox; reopen →
    the same card now says Remove; the Local tab lists your loras when LoRA
    Manager is installed.
12. **Live preview**: after Apply the status list fills WITHOUT queueing
    (rows marked "preview"); each row's ✕ deletes its line from the textbox;
    ⟳ re-parses hand-typed lines; reload the page → the list re-renders from
    the saved workflow. Searching gibberish → "No results were returned by
    CivitAI's public API…" with a link to the same search on civitai.com.

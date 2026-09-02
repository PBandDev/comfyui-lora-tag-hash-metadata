from collections.abc import Callable, Iterable
from dataclasses import dataclass
import hashlib
import math
from pathlib import Path, PurePosixPath
import re

try:
    import folder_paths
except ImportError:
    folder_paths = None

from comfy_api.v0_0_2 import ComfyExtension, io


# LoRA Manager emits 3-segment tags when model and clip strength differ
# (<lora:name:model:clip>); the weight we credit is the model strength.
LORA_PATTERN = re.compile(r"<lora:([^:>]+)(?::([^:>]+))?(?::([^:>]+))?>", re.IGNORECASE)
KNOWN_LORA_EXTENSIONS = (
    ".safetensors",
    ".ckpt",
    ".pth",
    ".pt",
    ".bin",
)
# A1111 strips ':' and ',' from names in its `Lora hashes:` line
# (extra_networks_lora.py); a '"' would end the quoted value early.
LORA_HASHES_NAME_STRIP = str.maketrans("", "", '":,')
# civitai truncates the whole settings line at the first `Resources: ` /
# `Hashed prompt: ` / `Hashed Negative prompt: `. With ':' stripped from names,
# only a name ENDING in one of these words can recreate that substring
# (`<name>: <hash>`), so those names get a trailing underscore.
CIVITAI_TRUNCATION_TOKENS = ("resources", "hashed prompt", "hashed negative prompt")


@dataclass(frozen=True)
class HashBridgeResult:
    additional_hashes: str
    resolved_loras: str
    missing_loras: str
    entries: tuple = ()
    lora_hashes: str = ""
    # (file stem, AutoV2) per resolved lora — the raw material of lora_hashes,
    # exposed so the v2 node can merge civitai loras into the same line.
    lora_pairs: tuple[tuple[str, str], ...] = ()


def _lora_hashes_name(name: str, autov2: str) -> str:
    cleaned = " ".join(name.translate(LORA_HASHES_NAME_STRIP).split())
    if not cleaned:
        return autov2
    if cleaned.lower().endswith(CIVITAI_TRUNCATION_TOKENS):
        return f"{cleaned}_"
    return cleaned


def format_lora_hashes(pairs: Iterable[tuple[str, str]]) -> str:
    """A1111 infotext fragment `Lora hashes: "name: hash, name2: hash2"` for
    Image Saver Metadata's `custom` input. Never weighted (the 3-field form
    breaks every reader) and no leading comma (Image Saver prepends `, `).
    Empty string when there is nothing to credit. One entry per hash (first
    occurrence wins) — two tags spelling the same file differently must not
    credit it twice."""
    seen: set[str] = set()
    parts: list[str] = []
    for name, autov2 in pairs:
        if autov2.upper() in seen:
            continue
        seen.add(autov2.upper())
        parts.append(f"{_lora_hashes_name(name, autov2)}: {autov2}")
    return f'Lora hashes: "{", ".join(parts)}"' if parts else ""


def parse_loaded_loras(value: str) -> list[tuple[str, float]]:
    parsed: list[tuple[str, float]] = []
    for name, raw_weight, _clip_strength in LORA_PATTERN.findall(value or ""):
        normalized_name = name.strip()
        if not normalized_name:
            continue
        if raw_weight is None or raw_weight == "":
            weight = 1.0
        else:
            try:
                weight = float(raw_weight.strip())
            except ValueError:
                continue
            if not math.isfinite(weight):
                continue
        parsed.append((normalized_name, weight))
    return parsed


def sha256_10(path: str) -> str:
    hasher = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while chunk := handle.read(8192):
            hasher.update(chunk)
    return hasher.hexdigest().upper()[:10]


def normalize_lora_reference(name: str) -> str:
    normalized = PurePosixPath(name.replace("\\", "/")).as_posix().strip().lower()
    for extension in KNOWN_LORA_EXTENSIONS:
        if normalized.endswith(extension):
            return normalized[: -len(extension)]
    return normalized


def resolve_lora_path(name: str) -> str | None:
    if folder_paths is None:
        return None

    filenames = folder_paths.get_filename_list("loras")
    requested_full = PurePosixPath(name.replace("\\", "/")).as_posix().strip().lower()
    requested_normalized = normalize_lora_reference(name)
    requested_basename = PurePosixPath(requested_normalized).name
    basename_matches: list[str] = []

    for candidate in filenames:
        candidate_text = str(candidate).replace("\\", "/")
        candidate_full = PurePosixPath(candidate_text).as_posix().lower()
        candidate_normalized = normalize_lora_reference(candidate_text)
        candidate_basename = PurePosixPath(candidate_normalized).name

        if candidate_full == requested_full or candidate_normalized == requested_normalized:
            return folder_paths.get_full_path("loras", candidate)
        if candidate_basename == requested_basename:
            basename_matches.append(candidate)

    for candidate in basename_matches:
        candidate_text = str(candidate).replace("\\", "/")
        candidate_basename = PurePosixPath(normalize_lora_reference(candidate_text)).name
        if candidate_basename == requested_basename:
            return folder_paths.get_full_path("loras", candidate)
    return None


def _format_missing_name(name: str) -> str:
    return name.replace("\\", "\\\\").replace(",", "\\,")


def build_additional_hashes(
    value: str,
    resolver: Callable[[str], str | None] = resolve_lora_path,
) -> HashBridgeResult:
    deduped: dict[str, float] = {}
    for name, weight in parse_loaded_loras(value):
        if name in deduped:
            del deduped[name]
        deduped[name] = weight

    formatted_hashes: list[str] = []
    resolved_loras: list[str] = []
    missing_loras: list[str] = []
    entries: list[dict] = []
    lora_pairs: list[tuple[str, str]] = []

    for name, weight in deduped.items():
        if "," in name:
            missing_loras.append(_format_missing_name(name))
            entries.append(
                {
                    "kind": "lora",
                    "name": name,
                    "status": "missing",
                    "error": "lora names cannot contain commas",
                }
            )
            continue
        resolved_path = resolver(name)
        if resolved_path is None:
            missing_loras.append(_format_missing_name(name))
            entries.append(
                {
                    "kind": "lora",
                    "name": name,
                    "status": "missing",
                    "error": "not found in loras folders",
                }
            )
            continue
        file_hash = sha256_10(resolved_path)
        formatted_hashes.append(f"{name}:{file_hash}:{weight}")
        resolved_loras.append(name)
        # A1111 keys `Lora hashes` by the file's bare stem, not the tag text
        # (which may carry a subfolder or different casing).
        lora_pairs.append((Path(resolved_path).stem, file_hash))
        entries.append(
            {
                "kind": "lora",
                "name": name,
                "hash": file_hash,
                "weight": weight,
                "status": "resolved",
            }
        )

    return HashBridgeResult(
        additional_hashes=",".join(formatted_hashes),
        resolved_loras=",".join(resolved_loras),
        missing_loras=",".join(missing_loras),
        entries=tuple(entries),
        lora_hashes=format_lora_hashes(lora_pairs),
        lora_pairs=tuple(lora_pairs),
    )


class LoraManagerToImageSaverHashes(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="LoraTagsToHashMetadata",
            display_name="LoRA Tags To Hash Metadata",
            category="utils/metadata",
            description=(
                "Convert <lora:name:weight> tags into Name:HASH:Weight metadata strings for "
                "downstream nodes, plus an A1111 `Lora hashes:` fragment for Image Saver "
                "Metadata's custom input."
            ),
            inputs=[io.String.Input("loaded_loras", multiline=True)],
            outputs=[
                io.String.Output("additional_hashes"),
                io.String.Output("resolved_loras"),
                io.String.Output("missing_loras"),
                io.String.Output("lora_hashes"),
            ],
        )

    @classmethod
    def execute(cls, loaded_loras: str) -> tuple[str, str, str, str]:
        result = build_additional_hashes(loaded_loras)
        return (
            result.additional_hashes,
            result.resolved_loras,
            result.missing_loras,
            result.lora_hashes,
        )


class LoraHashBridgeExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        if __package__:
            from .civitai_resources_node import CivitaiResourcesToHashMetadata
        else:
            from civitai_resources_node import CivitaiResourcesToHashMetadata
        return [LoraManagerToImageSaverHashes, CivitaiResourcesToHashMetadata]


def comfy_entrypoint() -> ComfyExtension:
    return LoraHashBridgeExtension()

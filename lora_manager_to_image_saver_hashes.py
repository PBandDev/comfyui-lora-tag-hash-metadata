from collections.abc import Callable
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


LORA_PATTERN = re.compile(r"<lora:([^:>]+)(?::([^:>]+))?>", re.IGNORECASE)
KNOWN_LORA_EXTENSIONS = (
    ".safetensors",
    ".ckpt",
    ".pth",
    ".pt",
    ".bin",
)


@dataclass(frozen=True)
class HashBridgeResult:
    additional_hashes: str
    resolved_loras: str
    missing_loras: str


def parse_loaded_loras(value: str) -> list[tuple[str, float]]:
    parsed: list[tuple[str, float]] = []
    for name, raw_weight in LORA_PATTERN.findall(value or ""):
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

    for name, weight in deduped.items():
        if "," in name:
            missing_loras.append(_format_missing_name(name))
            continue
        resolved_path = resolver(name)
        if resolved_path is None:
            missing_loras.append(_format_missing_name(name))
            continue
        formatted_hashes.append(f"{name}:{sha256_10(resolved_path)}:{weight}")
        resolved_loras.append(name)

    return HashBridgeResult(
        additional_hashes=",".join(formatted_hashes),
        resolved_loras=",".join(resolved_loras),
        missing_loras=",".join(missing_loras),
    )


class LoraManagerToImageSaverHashes(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="LoraTagsToHashMetadata",
            display_name="LoRA Tags To Hash Metadata",
            category="utils/metadata",
            description="Convert <lora:name:weight> tags into Name:HASH:Weight metadata strings for downstream nodes.",
            inputs=[io.String.Input("loaded_loras", multiline=True)],
            outputs=[
                io.String.Output("additional_hashes"),
                io.String.Output("resolved_loras"),
                io.String.Output("missing_loras"),
            ],
        )

    @classmethod
    def execute(cls, loaded_loras: str) -> tuple[str, str, str]:
        result = build_additional_hashes(loaded_loras)
        return (
            result.additional_hashes,
            result.resolved_loras,
            result.missing_loras,
        )


class LoraHashBridgeExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [LoraManagerToImageSaverHashes]


def comfy_entrypoint() -> ComfyExtension:
    return LoraHashBridgeExtension()

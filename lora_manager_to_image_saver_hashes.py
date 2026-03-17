from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import math
from pathlib import Path
import re

try:
    import folder_paths
except ImportError:
    folder_paths = None

try:
    from comfy_api.v0_0_2 import ComfyExtension, io
except ModuleNotFoundError as exc:
    if exc.name != "comfy_api":
        raise

    @dataclass(frozen=True)
    class _CompatStringPort:
        name: str
        multiline: bool = False

    class _CompatString:
        Type = str

        @staticmethod
        def Input(name: str, multiline: bool = False) -> _CompatStringPort:
            return _CompatStringPort(name=name, multiline=multiline)

        @staticmethod
        def Output(name: str) -> _CompatStringPort:
            return _CompatStringPort(name=name)

    @dataclass(frozen=True)
    class _CompatSchema:
        node_id: str
        display_name: str
        category: str
        description: str
        inputs: list[object]
        outputs: list[object]

    class _CompatComfyNode:
        pass

    class _CompatIO:
        ComfyNode = _CompatComfyNode
        Schema = _CompatSchema
        String = _CompatString

    class ComfyExtension:
        async def get_node_list(self) -> list[type[_CompatComfyNode]]:
            return []

    io = _CompatIO()


LORA_PATTERN = re.compile(r"<lora:([^:>]+)(?::([^:>]+))?>", re.IGNORECASE)


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
        if "," in normalized_name:
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


def resolve_lora_path(name: str) -> str | None:
    if folder_paths is None:
        return None

    filenames = folder_paths.get_filename_list("loras")
    normalized = Path(name).stem.lower()
    for candidate in filenames:
        if Path(candidate).stem.lower() == normalized:
            return folder_paths.get_full_path("loras", candidate)
    return None


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
        resolved_path = resolver(name)
        if resolved_path is None:
            missing_loras.append(name)
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
            node_id="LoraManagerToImageSaverHashes",
            display_name="LoraManager To Image Saver Hashes",
            category="ImageSaver/utils",
            description="Convert LoraManager loaded_loras text to Image Saver additional_hashes.",
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

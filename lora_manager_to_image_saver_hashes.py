from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import math
from pathlib import Path
import re


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


def build_additional_hashes(
    value: str,
    resolver: Callable[[str], str | None],
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

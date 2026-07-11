from __future__ import annotations

from dataclasses import dataclass
import re
from urllib.parse import parse_qs, urlsplit

URL_RE = re.compile(
    r"^https?://(?:www\.)?civitai\.(?:com|red|green)/models/(\d+)(?:/[^\s?]*)?(?:\?\S*)?$",
    re.IGNORECASE,
)
AIR_RE = re.compile(
    r"^urn:air:[a-z0-9]+:[a-z0-9]+:civitai:(\d+)@(\d+)(?:\+(\d+))?$",
    re.IGNORECASE,
)
HASH10_RE = re.compile(r"^[0-9a-f]{10}$", re.IGNORECASE)
HASH64_RE = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
WEIGHT_SUFFIX_RE = re.compile(r"\s+([-+]?\d+(?:\.\d+)?)$")


@dataclass(frozen=True)
class ResourceLine:
    raw: str
    kind: str  # "url" | "hash" | "air" | "invalid"
    model_id: int | None = None
    version_id: int | None = None
    file_id: int | None = None
    hash: str | None = None
    weight: float | None = None
    error: str | None = None


def parse_resource_lines(text: str) -> list[ResourceLine]:
    lines: list[ResourceLine] = []
    for raw in (text or "").splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        weight: float | None = None
        body = stripped
        if (weight_match := WEIGHT_SUFFIX_RE.search(body)) is not None:
            weight = float(weight_match.group(1))
            body = body[: weight_match.start()].strip()
        if (url_match := URL_RE.match(body)) is not None:
            query = parse_qs(urlsplit(body).query)
            version_raw = (query.get("modelVersionId") or [None])[0]
            lines.append(
                ResourceLine(
                    raw=stripped,
                    kind="url",
                    model_id=int(url_match.group(1)),
                    version_id=int(version_raw)
                    if version_raw is not None and version_raw.isdigit()
                    else None,
                    weight=weight,
                )
            )
        elif (air_match := AIR_RE.match(body)) is not None:
            lines.append(
                ResourceLine(
                    raw=stripped,
                    kind="air",
                    model_id=int(air_match.group(1)),
                    version_id=int(air_match.group(2)),
                    file_id=int(air_match.group(3)) if air_match.group(3) else None,
                    weight=weight,
                )
            )
        elif HASH10_RE.match(body) or HASH64_RE.match(body):
            lines.append(
                ResourceLine(raw=stripped, kind="hash", hash=body[:10].upper(), weight=weight)
            )
        else:
            lines.append(
                ResourceLine(
                    raw=stripped,
                    kind="invalid",
                    weight=weight,
                    error=(
                        "unrecognized line (expected civitai model URL, "
                        "AutoV2/SHA256 hash, or AIR URN)"
                    ),
                )
            )
    return lines

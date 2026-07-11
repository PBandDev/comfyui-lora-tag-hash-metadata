from __future__ import annotations

from dataclasses import dataclass
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

try:
    import folder_paths
except ImportError:
    folder_paths = None

time_real = time.time
API_HOSTS = ("https://civitai.com", "https://civitai.red")
MODEL_TTL_SECONDS = 86400
HTTP_TIMEOUT_SECONDS = 10.0

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


class ResolveError(Exception):
    pass


class NotFoundError(ResolveError):
    pass


def default_fetch(path: str) -> object:
    token = os.environ.get("CIVITAI_API_TOKEN", "")
    last: Exception | None = None
    for delay in (0.0, 1.0, 2.0):
        if delay:
            time.sleep(delay)
        for host in API_HOSTS:
            request = urllib.request.Request(host + path)
            if token:
                request.add_header("Authorization", f"Bearer {token}")
            try:
                with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as err:
                if err.code == 404:
                    raise NotFoundError(f"not found: {path}") from err
                last = err
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
                last = err
    raise ResolveError(f"civitai api unreachable: {last}")


def _cache_file() -> Path:
    if folder_paths is not None and hasattr(folder_paths, "get_user_directory"):
        base = Path(folder_paths.get_user_directory()) / "comfyui-lora-tag-hash-metadata"
    else:
        base = Path(__file__).parent / ".cache"
    base.mkdir(parents=True, exist_ok=True)
    return base / "civitai_cache.json"


class ResolveCache:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or _cache_file()
        try:
            self._data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self._data = {}
        if not isinstance(self._data, dict):
            self._data = {}

    def get(self, key: str, max_age: float | None = None) -> object | None:
        entry = self._data.get(key)
        if not isinstance(entry, dict):
            return None
        fetched_at = entry.get("fetched_at")
        if not isinstance(fetched_at, (int, float)):
            return None
        if max_age is not None and time.time() - fetched_at > max_age:
            return None
        return entry.get("value")

    def put(self, key: str, value: object) -> None:
        self._data[key] = {"fetched_at": time.time(), "value": value}
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data), encoding="utf-8")
        tmp.replace(self.path)


@dataclass(frozen=True)
class ResolvedResource:
    line: ResourceLine
    name: str
    type: str
    autov2: str
    model_id: int | None = None
    version_id: int | None = None
    version_name: str = ""
    unverified: bool = False

    @property
    def weight(self) -> float | None:
        return self.line.weight


def _pick_autov2(files: list, file_id: int | None) -> str:
    candidates = [
        f
        for f in files
        if isinstance(f, dict) and isinstance(f.get("hashes"), dict) and f["hashes"].get("AutoV2")
    ]
    if file_id is not None:
        candidates = [f for f in candidates if f.get("id") == file_id]
    if not candidates:
        if file_id is not None:
            raise ResolveError(f"no file with id {file_id} and an AutoV2 hash on this version")
        raise ResolveError("no file with an AutoV2 hash on this version")
    primary = next((f for f in candidates if f.get("primary")), candidates[0])
    return str(primary["hashes"]["AutoV2"]).upper()


def _from_version_payload(line: ResourceLine, data: dict) -> ResolvedResource:
    model = data.get("model")
    if not isinstance(model, dict):
        model = {}
    return ResolvedResource(
        line=line,
        name=str(model.get("name") or "").strip(),
        type=str(model.get("type") or "Unknown"),
        autov2=_pick_autov2(data.get("files") or [], line.file_id),
        model_id=data.get("modelId") or line.model_id,
        version_id=data.get("id"),
        version_name=str(data.get("name") or ""),
    )


def resolve_line(line: ResourceLine, cache: ResolveCache, fetch=default_fetch) -> ResolvedResource:
    if line.kind == "invalid":
        raise ResolveError(line.error or "invalid line")
    if line.kind == "hash":
        assert line.hash is not None
        cached = cache.get(f"h:{line.hash}")
        if isinstance(cached, dict):
            return _from_version_payload(line, cached)
        try:
            data = fetch(f"/api/v1/model-versions/by-hash/{line.hash}")
        except ResolveError:
            return ResolvedResource(
                line=line, name=line.hash, type="Unknown", autov2=line.hash, unverified=True
            )
        if isinstance(data, dict):
            cache.put(f"h:{line.hash}", data)
            return _from_version_payload(line, data)
        return ResolvedResource(
            line=line, name=line.hash, type="Unknown", autov2=line.hash, unverified=True
        )
    if line.version_id is not None:  # pinned url or air
        cached = cache.get(f"v:{line.version_id}")
        if isinstance(cached, dict):
            return _from_version_payload(line, cached)
        data = fetch(f"/api/v1/model-versions/{line.version_id}")
        if not isinstance(data, dict):
            raise ResolveError("unexpected civitai api payload")
        cache.put(f"v:{line.version_id}", data)
        return _from_version_payload(line, data)
    cached = cache.get(f"m:{line.model_id}", max_age=MODEL_TTL_SECONDS)
    if not isinstance(cached, dict):
        cached = fetch(f"/api/v1/models/{line.model_id}")
        if not isinstance(cached, dict):
            raise ResolveError("unexpected civitai api payload")
        cache.put(f"m:{line.model_id}", cached)
    versions = cached.get("modelVersions") or []
    if not versions:
        raise ResolveError("model has no published versions")
    latest = versions[0]
    if not isinstance(latest, dict):
        raise ResolveError("unexpected civitai api payload")
    return ResolvedResource(
        line=line,
        name=str(cached.get("name") or "").strip(),
        type=str(cached.get("type") or "Unknown"),
        autov2=_pick_autov2(latest.get("files") or [], None),
        model_id=cached.get("id"),
        version_id=latest.get("id"),
        version_name=str(latest.get("name") or ""),
    )

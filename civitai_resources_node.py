from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import math
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

try:
    import folder_paths
except ImportError:
    folder_paths = None

from comfy_api.v0_0_2 import io

if __package__:
    from .lora_manager_to_image_saver_hashes import build_additional_hashes, resolve_lora_path
else:
    from lora_manager_to_image_saver_hashes import build_additional_hashes, resolve_lora_path

time_real = time.time
API_HOSTS = ("https://civitai.com", "https://civitai.red")
MODEL_TTL_SECONDS = 86400
HTTP_TIMEOUT_SECONDS = 10.0
# Cloudflare returns 403 for urllib's default "Python-urllib/x.y" agent.
USER_AGENT = "comfyui-lora-tag-hash-metadata"
# After this many consecutive fetch failures in one run, remaining uncached
# lines are skipped instead of burning the full retry budget per line.
FETCH_BREAKER_LIMIT = 2
# Image Saver's parse_manual_hashes silently ignores entries past 30.
IMAGE_SAVER_MANUAL_CAP = 30
AUTOV2_RE = re.compile(r"^[0-9A-F]{10}$")
# civitai image urls carry a transform directive segment right before the
# filename (e.g. /original=true/ or /width=450/) — swap it for a thumbnail.
THUMBNAIL_TRANSFORM_RE = re.compile(r"/(?:original=true|width=\d+)[^/]*/")
THUMBNAIL_TRANSFORM = "/width=96,anim=false/"

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
            if not math.isfinite(weight):
                lines.append(
                    ResourceLine(
                        raw=stripped,
                        kind="invalid",
                        error="weight overflows to a non-finite number",
                    )
                )
                continue
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
    last: Exception | None = None
    saw_404 = False
    for delay in (0.0, 1.0, 2.0):
        if delay:
            time.sleep(delay)
        not_found_count = 0
        for host in API_HOSTS:
            request = urllib.request.Request(host + path, headers={"User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as err:
                if err.code == 404:
                    saw_404 = True
                    not_found_count += 1
                last = err
            # ValueError covers json.JSONDecodeError and UnicodeDecodeError
            # (a proxy can return 200 with garbage bytes).
            except (urllib.error.URLError, TimeoutError, ValueError) as err:
                last = err
        # A single-host 404 may be transient/stale; trust it only when every
        # host agrees within one attempt round.
        if not_found_count == len(API_HOSTS):
            raise NotFoundError(f"not found: {path}") from last
    if saw_404:
        raise NotFoundError(f"not found: {path}") from last
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
        if not isinstance(fetched_at, (int, float)) or not math.isfinite(fetched_at):
            return None
        if max_age is not None and time.time() - fetched_at > max_age:
            return None
        return entry.get("value")

    def put(self, key: str, value: object) -> None:
        self._data[key] = {"fetched_at": time.time(), "value": value}
        # Unique tmp name per writer so concurrent executions can't trample
        # each other's tmp file; persistence is best-effort — a cache I/O
        # failure must never abort node execution.
        tmp = self.path.with_name(f"{self.path.name}.{os.getpid()}-{id(self):x}.tmp")
        try:
            tmp.write_text(json.dumps(self._data), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass


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
    thumbnail: str | None = None

    @property
    def weight(self) -> float | None:
        return self.line.weight


def _thumbnail_from_images(images: object) -> str | None:
    """Rewrite the resource's first preview image to a ~96px thumbnail url."""
    if not isinstance(images, list):
        return None
    for image in images:
        if isinstance(image, dict) and isinstance(image.get("url"), str):
            return THUMBNAIL_TRANSFORM_RE.sub(THUMBNAIL_TRANSFORM, image["url"], count=1)
    return None


def _local_lora_thumbnail(full_path: str) -> str | None:
    """Stock ComfyUI serves model-folder sidecar previews at
    /experiment/models/preview/loras/{path_index}/{relative path}."""
    if folder_paths is None or not hasattr(folder_paths, "get_folder_paths"):
        return None
    try:
        bases = folder_paths.get_folder_paths("loras")
    except (KeyError, ValueError):
        return None
    resolved = Path(full_path).resolve()
    for index, base in enumerate(bases):
        try:
            relative = resolved.relative_to(Path(base).resolve())
        except ValueError:
            continue
        relative_posix = "/".join(relative.parts)
        return f"/experiment/models/preview/loras/{index}/{quote(relative_posix)}"
    return None


def _file_autov2(file_entry: object) -> str | None:
    if not isinstance(file_entry, dict):
        return None
    hashes = file_entry.get("hashes")
    if not isinstance(hashes, dict):
        return None
    value = str(hashes.get("AutoV2") or "").upper()
    # Emitting an unvalidated value downstream could inject extra CSV entries
    # or exceed Image Saver's hash length cap.
    return value if AUTOV2_RE.match(value) else None


def _pick_autov2(files: list, file_id: int | None) -> str:
    candidates = [f for f in files if _file_autov2(f) is not None]
    if file_id is not None:
        candidates = [f for f in candidates if f.get("id") == file_id]
    if not candidates:
        if file_id is not None:
            raise ResolveError(f"no file with id {file_id} and a valid AutoV2 hash on this version")
        raise ResolveError("no file with a valid AutoV2 hash on this version")
    primary = next((f for f in candidates if f.get("primary")), candidates[0])
    autov2 = _file_autov2(primary)
    assert autov2 is not None
    return autov2


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
        thumbnail=_thumbnail_from_images(data.get("images")),
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
        thumbnail=_thumbnail_from_images(latest.get("images")),
    )


def sanitize_name(name: str, fallback: str) -> str:
    cleaned = re.sub(r"\s+", " ", re.sub(r"[,:]", " ", name)).strip()
    if not cleaned:
        return fallback
    if cleaned.lower() == "vae":
        return f"{cleaned} model"
    return cleaned


def format_entry(name: str, autov2: str, weight: float | None) -> str:
    if weight is None and autov2.isdigit():
        # Image Saver parses a trailing all-decimal token as a weight, which
        # would swallow the hash itself — pin an explicit weight instead.
        weight = 1.0
    suffix = f":{weight}" if weight is not None else ""
    return f"{name}:{autov2}{suffix}"


def _escape_missing(raw: str) -> str:
    return raw.replace("\\", "\\\\").replace(",", "\\,")


@dataclass(frozen=True)
class ResourceReport:
    additional_hashes: str
    resolved: str
    missing: str
    resources_json: str


def build_resource_report(
    loaded_loras: str,
    civitai_resources: str,
    lora_resolver=None,
    cache: ResolveCache | None = None,
    fetch=None,
) -> ResourceReport:
    resolver = lora_resolver or resolve_lora_path
    from_v1 = build_additional_hashes(loaded_loras or "", resolver)
    cache = cache if cache is not None else ResolveCache()
    fetch = fetch if fetch is not None else default_fetch
    entries: list[dict] = [dict(entry) for entry in from_v1.entries]
    for entry in entries:
        if entry.get("status") != "resolved":
            continue
        lora_path = resolver(str(entry.get("name") or ""))
        if lora_path:
            entry["thumbnail"] = _local_lora_thumbnail(lora_path)
    seen_hashes = {
        str(entry["hash"]).upper() for entry in entries if entry.get("hash")
    }
    hash_parts = [from_v1.additional_hashes] if from_v1.additional_hashes else []
    resolved_names = [from_v1.resolved_loras] if from_v1.resolved_loras else []
    missing_parts = [from_v1.missing_loras] if from_v1.missing_loras else []
    emitted_count = sum(1 for entry in entries if entry.get("status") == "resolved")

    # Circuit breaker: once the API proves unreachable, stop burning the full
    # retry budget on every remaining uncached line (30 lines could otherwise
    # block the queue for ~30 minutes).
    fetch_failures = 0

    def guarded_fetch(path: str) -> object:
        nonlocal fetch_failures
        if fetch_failures >= FETCH_BREAKER_LIMIT:
            raise ResolveError("civitai api unreachable (skipped after repeated failures)")
        try:
            result = fetch(path)
        except NotFoundError:
            raise
        except ResolveError:
            fetch_failures += 1
            raise
        fetch_failures = 0
        return result

    for line in parse_resource_lines(civitai_resources or ""):
        entry: dict = {"kind": line.kind, "source": line.raw}
        try:
            res = resolve_line(line, cache, guarded_fetch)
        except ResolveError as err:
            entry.update(status="missing", error=str(err))
            missing_parts.append(_escape_missing(line.raw))
            entries.append(entry)
            continue
        name = sanitize_name(res.name, res.autov2)
        entry.update(
            status="resolved",
            name=name,
            type=res.type,
            hash=res.autov2,
            model_id=res.model_id,
            version_id=res.version_id,
            version_name=res.version_name,
            weight=res.weight,
            unverified=res.unverified,
            thumbnail=res.thumbnail,
        )
        if res.autov2.upper() in seen_hashes:
            entry["status"] = "duplicate"
            entries.append(entry)
            continue
        seen_hashes.add(res.autov2.upper())
        hash_parts.append(format_entry(name, res.autov2, res.weight))
        resolved_names.append(name)
        emitted_count += 1
        if emitted_count > IMAGE_SAVER_MANUAL_CAP:
            entry["warning"] = (
                f"beyond Image Saver's {IMAGE_SAVER_MANUAL_CAP}-entry manual cap — may be ignored"
            )
        entries.append(entry)

    return ResourceReport(
        additional_hashes=",".join(hash_parts),
        resolved=",".join(resolved_names),
        missing=",".join(missing_parts),
        resources_json=json.dumps(entries),
    )


def preview_resources_json(
    civitai_resources: str,
    cache: ResolveCache | None = None,
    fetch=None,
) -> str:
    """Entries payload for the frontend live preview — same pipeline as a run,
    minus loaded_loras (only known at execution time)."""
    return build_resource_report("", civitai_resources, cache=cache, fetch=fetch).resources_json


class CivitaiResourcesToHashMetadata(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="CivitaiResourcesToHashMetadata",
            display_name="Civitai Resources To Hash Metadata",
            category="utils/metadata",
            description=(
                "Credit local lora tags AND any CivitAI resource (URL / AutoV2 / SHA256 / "
                "AIR, one per line; optional trailing weight; # comments) as "
                "Name:AUTOV2[:Weight] metadata entries."
            ),
            inputs=[
                io.String.Input("loaded_loras", multiline=True, optional=True, force_input=True),
                io.String.Input(
                    "civitai_resources",
                    multiline=True,
                    default="",
                    placeholder="https://civitai.com/models/... | AutoV2 | urn:air:... (# comments ok)",
                ),
            ],
            outputs=[
                io.String.Output("additional_hashes"),
                io.String.Output("resolved"),
                io.String.Output("missing"),
                io.String.Output("resources_json"),
            ],
            # Output node: executes standalone so the status list fills without
            # requiring a downstream saver to be wired up.
            is_output_node=True,
        )

    @classmethod
    def execute(cls, loaded_loras: str = "", civitai_resources: str = "") -> io.NodeOutput:
        report = build_resource_report(loaded_loras, civitai_resources)
        return io.NodeOutput(
            report.additional_hashes,
            report.resolved,
            report.missing,
            report.resources_json,
            ui={"civitai_resources_status": [report.resources_json]},
        )


def _register_preview_route() -> None:
    try:
        from aiohttp import web
        from server import PromptServer  # noqa: PLC0415 - only exists inside ComfyUI
    except Exception:
        return

    @PromptServer.instance.routes.post("/clth/preview")
    async def clth_preview(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        text = str(data.get("text", "")) if isinstance(data, dict) else ""
        loop = asyncio.get_running_loop()
        payload = await loop.run_in_executor(None, preview_resources_json, text)
        return web.Response(text=payload, content_type="application/json")


_register_preview_route()

from dataclasses import dataclass, field
import hashlib
import importlib.util
import json
import types
from pathlib import Path
import sys

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))


@dataclass(frozen=True)
class _FakeStringPort:
    name: str
    multiline: bool = False
    optional: bool = False
    force_input: bool = False
    default: str | None = None
    placeholder: str | None = None


class _FakeString:
    Type = str

    @staticmethod
    def Input(
        name: str,
        multiline: bool = False,
        optional: bool = False,
        force_input: bool = False,
        default: str | None = None,
        placeholder: str | None = None,
    ) -> _FakeStringPort:
        return _FakeStringPort(
            name=name,
            multiline=multiline,
            optional=optional,
            force_input=force_input,
            default=default,
            placeholder=placeholder,
        )

    @staticmethod
    def Output(name: str) -> _FakeStringPort:
        return _FakeStringPort(name=name)


@dataclass(frozen=True)
class _FakeSchema:
    node_id: str
    display_name: str
    category: str
    description: str
    inputs: list[object]
    outputs: list[object]
    is_output_node: bool = False


class _FakeComfyNode:
    pass


@dataclass(frozen=True)
class _FakeNodeOutput:
    args: tuple
    ui: dict | None = field(default=None)


def _make_node_output(*args: object, ui: dict | None = None) -> _FakeNodeOutput:
    return _FakeNodeOutput(args=args, ui=ui)


class _FakeIO:
    ComfyNode = _FakeComfyNode
    Schema = _FakeSchema
    String = _FakeString
    NodeOutput = staticmethod(_make_node_output)


class _FakeComfyExtension:
    async def get_node_list(self) -> list[type[_FakeComfyNode]]:
        return []


def _install_fake_comfy_api() -> None:
    comfy_api_module = types.ModuleType("comfy_api")
    comfy_api_module.__path__ = []

    comfy_api_v002_module = types.ModuleType("comfy_api.v0_0_2")
    comfy_api_v002_module.ComfyExtension = _FakeComfyExtension
    comfy_api_v002_module.io = _FakeIO()

    comfy_api_module.v0_0_2 = comfy_api_v002_module

    sys.modules["comfy_api"] = comfy_api_module
    sys.modules["comfy_api.v0_0_2"] = comfy_api_v002_module


def _load_module_from_path(module_name: str, module_path: Path):
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    assert spec is not None
    assert spec.loader is not None

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        del sys.modules[module_name]
        raise
    return module


_install_fake_comfy_api()
cnode = _load_module_from_path(
    "civitai_resources_node",
    REPO_ROOT / "civitai_resources_node.py",
)
parse_resource_lines = cnode.parse_resource_lines


def test_parse_url_all_domains_and_version_pin() -> None:
    lines = parse_resource_lines(
        "https://civitai.com/models/2767064/anima-detailer?modelVersionId=3114726\n"
        "https://civitai.red/models/1362968/some-slug\n"
        "https://www.civitai.green/models/2598886\n"
    )
    assert [(line.kind, line.model_id, line.version_id) for line in lines] == [
        ("url", 2767064, 3114726),
        ("url", 1362968, None),
        ("url", 2598886, None),
    ]


def test_parse_hashes_air_weight_comments() -> None:
    lines = parse_resource_lines(
        "# comment\n\n"
        "D6A3AC6F8A\n"
        "D6A3AC6F8AFCD05878C808EAD9E2E98BED2773C551C86104BF4C7C4F485F7001\n"
        "urn:air:anima:lora:civitai:2767064@3114726\n"
        "https://civitai.com/models/2767064 0.8\n"
    )
    assert [line.kind for line in lines] == ["hash", "hash", "air", "url"]
    assert lines[0].hash == "D6A3AC6F8A"
    assert lines[1].hash == "D6A3AC6F8A"
    assert (lines[2].model_id, lines[2].version_id) == (2767064, 3114726)
    assert lines[3].weight == 0.8


def test_parse_rejects_bare_ids_and_junk() -> None:
    lines = parse_resource_lines("2767064\nnot a url\nhttps://example.com/models/5\n")
    assert [line.kind for line in lines] == ["invalid", "invalid", "invalid"]
    assert all(line.error for line in lines)


def test_parse_air_file_id_suffix() -> None:
    (line,) = parse_resource_lines("urn:air:sdxl:lora:civitai:111@222+333")
    assert (line.kind, line.model_id, line.version_id, line.file_id) == ("air", 111, 222, 333)


def _fake_fetch(payloads: dict[str, object]):
    calls: list[str] = []

    def fetch(path: str) -> object:
        calls.append(path)
        if path not in payloads:
            raise cnode.NotFoundError(f"not found: {path}")
        return payloads[path]

    fetch.calls = calls
    return fetch


MODEL_2767064 = {
    "id": 2767064,
    "name": "Anima Detailer",
    "type": "LORA",
    "modelVersions": [
        {
            "id": 3114726,
            "name": "v0_8",
            "index": 0,
            "files": [
                {
                    "id": 2994936,
                    "name": "x.safetensors",
                    "primary": True,
                    "hashes": {"AutoV2": "CD64AF8696"},
                }
            ],
        }
    ],
}
VERSION_3114726 = {
    "id": 3114726,
    "modelId": 2767064,
    "name": "v0_8",
    "model": {"name": "Anima Detailer", "type": "LORA"},
    "files": [{"id": 2994936, "hashes": {"AutoV2": "CD64AF8696"}}],
}


def test_resolve_unpinned_url_uses_latest_version(tmp_path: Path) -> None:
    cache = cnode.ResolveCache(tmp_path / "cache.json")
    fetch = _fake_fetch({"/api/v1/models/2767064": MODEL_2767064})
    (line,) = parse_resource_lines("https://civitai.com/models/2767064")
    res = cnode.resolve_line(line, cache, fetch)
    assert (res.name, res.autov2, res.version_id, res.type) == (
        "Anima Detailer",
        "CD64AF8696",
        3114726,
        "LORA",
    )


def test_resolve_pinned_uses_version_endpoint_and_caches_forever(
    tmp_path: Path, monkeypatch
) -> None:
    cache = cnode.ResolveCache(tmp_path / "cache.json")
    fetch = _fake_fetch({"/api/v1/model-versions/3114726": VERSION_3114726})
    (line,) = parse_resource_lines("https://civitai.com/models/2767064?modelVersionId=3114726")
    cnode.resolve_line(line, cache, fetch)
    monkeypatch.setattr(cnode.time, "time", lambda: cnode.time_real() + 10 * 365 * 86400)
    res = cnode.resolve_line(line, cnode.ResolveCache(tmp_path / "cache.json"), _fake_fetch({}))
    assert res.autov2 == "CD64AF8696"  # served from persisted cache, no fetch


def test_unpinned_model_cache_expires_after_24h(tmp_path: Path, monkeypatch) -> None:
    cache_file = tmp_path / "cache.json"
    fetch = _fake_fetch({"/api/v1/models/2767064": MODEL_2767064})
    (line,) = parse_resource_lines("https://civitai.com/models/2767064")
    cnode.resolve_line(line, cnode.ResolveCache(cache_file), fetch)
    monkeypatch.setattr(cnode.time, "time", lambda: cnode.time_real() + 86401)
    cnode.resolve_line(line, cnode.ResolveCache(cache_file), fetch)
    assert fetch.calls.count("/api/v1/models/2767064") == 2


def test_resolve_404_reports_missing(tmp_path: Path) -> None:
    (line,) = parse_resource_lines("https://civitai.com/models/999999999")
    with pytest.raises(cnode.ResolveError, match="not found"):
        cnode.resolve_line(line, cnode.ResolveCache(tmp_path / "c.json"), _fake_fetch({}))


def test_hash_line_survives_failed_lookup(tmp_path: Path) -> None:
    (line,) = parse_resource_lines("D6A3AC6F8A")
    res = cnode.resolve_line(line, cnode.ResolveCache(tmp_path / "c.json"), _fake_fetch({}))
    assert (res.autov2, res.name, res.unverified) == ("D6A3AC6F8A", "D6A3AC6F8A", True)


def test_default_fetch_sends_no_auth_even_with_token_env(monkeypatch) -> None:
    captured: list = []

    class _Response:
        status = 200

        def read(self) -> bytes:
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *args: object) -> None:
            return None

    def fake_urlopen(request, timeout=None):
        captured.append(request)
        return _Response()

    monkeypatch.setattr(cnode.urllib.request, "urlopen", fake_urlopen)
    # Token support was removed: every endpoint used is public, and the header
    # must never be sent even when a token exists in the environment.
    monkeypatch.setenv("CIVITAI_API_TOKEN", "should-be-ignored")
    cnode.default_fetch("/api/v1/model-versions/1")

    request = captured[0]
    # Cloudflare 403s urllib's default Python-urllib agent.
    assert request.get_header("User-agent") == cnode.USER_AGENT
    assert request.get_header("Authorization") is None


def test_parse_rejects_non_finite_weight() -> None:
    huge = "9" * 400
    (line,) = parse_resource_lines(f"https://civitai.com/models/2767064 {huge}")
    assert line.kind == "invalid"
    assert "non-finite" in (line.error or "")


def test_pick_autov2_rejects_malformed_hash(tmp_path: Path) -> None:
    poisoned = {
        "id": 1,
        "modelId": 2,
        "name": "v1",
        "model": {"name": "Evil", "type": "LORA"},
        "files": [{"id": 3, "hashes": {"AutoV2": "ABC,FORGED:1234567890"}}],
    }
    fetch = _fake_fetch({"/api/v1/model-versions/3114726": poisoned})
    (line,) = parse_resource_lines("https://civitai.com/models/2767064?modelVersionId=3114726")
    with pytest.raises(cnode.ResolveError, match="valid AutoV2"):
        cnode.resolve_line(line, cnode.ResolveCache(tmp_path / "c.json"), fetch)


def test_cache_get_ignores_non_finite_fetched_at(tmp_path: Path) -> None:
    cache_file = tmp_path / "c.json"
    cache_file.write_text(
        '{"m:1": {"fetched_at": Infinity, "value": {"id": 1}}}', encoding="utf-8"
    )
    cache = cnode.ResolveCache(cache_file)
    assert cache.get("m:1", max_age=cnode.MODEL_TTL_SECONDS) is None


def test_cache_put_survives_replace_failure(tmp_path: Path, monkeypatch) -> None:
    cache = cnode.ResolveCache(tmp_path / "c.json")

    def broken_replace(self: Path, target) -> None:
        raise OSError("locked by another process")

    monkeypatch.setattr(Path, "replace", broken_replace)
    cache.put("v:1", {"id": 1})  # must not raise
    assert cache.get("v:1") == {"id": 1}  # in-memory copy still serves


def _urlopen_stub(responses: dict[str, object]):
    """Map full request url -> bytes payload or int http error code."""
    import io as _io
    import urllib.error as _err

    calls: list[str] = []

    class _Response:
        def __init__(self, payload: bytes) -> None:
            self._payload = payload

        def read(self) -> bytes:
            return self._payload

        def __enter__(self):
            return self

        def __exit__(self, *args: object) -> None:
            return None

    def urlopen(request, timeout=None):
        url = request.full_url
        calls.append(url)
        outcome = responses[url]
        if isinstance(outcome, int):
            raise _err.HTTPError(url, outcome, "err", None, _io.BytesIO(b""))
        assert isinstance(outcome, bytes)
        return _Response(outcome)

    urlopen.calls = calls
    return urlopen


def test_default_fetch_single_host_404_falls_through_to_other_host(monkeypatch) -> None:
    stub = _urlopen_stub(
        {
            "https://civitai.com/api/v1/model-versions/1": 404,
            "https://civitai.red/api/v1/model-versions/1": b'{"id": 1}',
        }
    )
    monkeypatch.setattr(cnode.urllib.request, "urlopen", stub)
    assert cnode.default_fetch("/api/v1/model-versions/1") == {"id": 1}


def test_default_fetch_404_on_all_hosts_raises_not_found(monkeypatch) -> None:
    stub = _urlopen_stub(
        {
            "https://civitai.com/api/v1/model-versions/1": 404,
            "https://civitai.red/api/v1/model-versions/1": 404,
        }
    )
    monkeypatch.setattr(cnode.urllib.request, "urlopen", stub)
    with pytest.raises(cnode.NotFoundError):
        cnode.default_fetch("/api/v1/model-versions/1")
    assert len(stub.calls) == 2  # no pointless retries once both hosts agree


def test_default_fetch_invalid_utf8_is_soft_resolve_error(monkeypatch) -> None:
    stub = _urlopen_stub(
        {
            "https://civitai.com/api/v1/model-versions/1": b"\xff\xfe\xfa",
            "https://civitai.red/api/v1/model-versions/1": b"\xff\xfe\xfa",
        }
    )
    monkeypatch.setattr(cnode.urllib.request, "urlopen", stub)
    monkeypatch.setattr(cnode.time, "sleep", lambda seconds: None)
    with pytest.raises(cnode.ResolveError, match="unreachable"):
        cnode.default_fetch("/api/v1/model-versions/1")


def test_build_report_circuit_breaker_stops_after_repeated_failures(tmp_path: Path) -> None:
    calls: list[str] = []

    def failing_fetch(path: str) -> object:
        calls.append(path)
        raise cnode.ResolveError("civitai api unreachable: boom")

    urls = "\n".join(f"https://civitai.com/models/{i}" for i in range(1, 6))
    report = cnode.build_resource_report(
        loaded_loras="",
        civitai_resources=urls,
        lora_resolver=lambda name: None,
        cache=cnode.ResolveCache(tmp_path / "c.json"),
        fetch=failing_fetch,
    )
    assert len(calls) == cnode.FETCH_BREAKER_LIMIT  # remaining lines skipped
    payload = json.loads(report.resources_json)
    assert [e["status"] for e in payload] == ["missing"] * 5


def test_build_report_warns_beyond_image_saver_cap(tmp_path: Path) -> None:
    hashes = "\n".join(f"{i:010d}" for i in range(31))
    report = cnode.build_resource_report(
        loaded_loras="",
        civitai_resources=hashes,
        lora_resolver=lambda name: None,
        cache=cnode.ResolveCache(tmp_path / "c.json"),
        fetch=_fake_fetch({}),
    )
    payload = json.loads(report.resources_json)
    assert len(payload) == 31
    assert "warning" not in payload[29]
    assert "30-entry" in payload[30]["warning"]


def test_thumbnail_from_images_uses_first_and_rewrites_transform() -> None:
    images = [
        {"url": "https://image.civitai.com/b/u1/original=true/1.jpeg"},
        {"url": "https://image.civitai.com/b/u2/width=450/2.jpeg"},
    ]
    url = cnode._thumbnail_from_images(images)
    assert url == "https://image.civitai.com/b/u1/width=96,anim=false/1.jpeg"

    url = cnode._thumbnail_from_images([{"nope": 1}, images[1]])  # skip malformed
    assert url == "https://image.civitai.com/b/u2/width=96,anim=false/2.jpeg"

    assert cnode._thumbnail_from_images([]) is None
    assert cnode._thumbnail_from_images(None) is None


def test_resolve_carries_thumbnail_from_version_payload(tmp_path: Path) -> None:
    payload = dict(VERSION_3114726)
    payload["images"] = [{"url": "https://image.civitai.com/b/u/original=true/9.jpeg"}]
    fetch = _fake_fetch({"/api/v1/model-versions/3114726": payload})
    (line,) = parse_resource_lines("https://civitai.com/models/2767064?modelVersionId=3114726")
    res = cnode.resolve_line(line, cnode.ResolveCache(tmp_path / "c.json"), fetch)
    assert res.thumbnail == "https://image.civitai.com/b/u/width=96,anim=false/9.jpeg"


def test_local_lora_thumbnail_builds_stock_preview_route(tmp_path: Path, monkeypatch) -> None:
    base = tmp_path / "loras"
    target = base / "Illustrious" / "anime style.safetensors"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"x")
    folder_paths = types.SimpleNamespace(get_folder_paths=lambda category: [str(base)])
    monkeypatch.setattr(cnode, "folder_paths", folder_paths, raising=False)

    assert cnode._local_lora_thumbnail(str(target)) == (
        "/experiment/models/preview/loras/0/Illustrious/anime%20style.safetensors"
    )
    assert cnode._local_lora_thumbnail(str(tmp_path / "elsewhere.safetensors")) is None


def test_build_report_attaches_local_thumbnail_to_lora_entries(
    tmp_path: Path, monkeypatch
) -> None:
    base = tmp_path / "loras"
    foo = base / "foo.safetensors"
    base.mkdir()
    foo.write_bytes(b"abc")
    folder_paths = types.SimpleNamespace(get_folder_paths=lambda category: [str(base)])
    monkeypatch.setattr(cnode, "folder_paths", folder_paths, raising=False)

    report = cnode.build_resource_report(
        loaded_loras="<lora:foo:0.8>",
        civitai_resources="",
        lora_resolver=lambda name: str(foo) if name == "foo" else None,
        cache=cnode.ResolveCache(tmp_path / "c.json"),
        fetch=_fake_fetch({}),
    )
    payload = json.loads(report.resources_json)
    assert payload[0]["thumbnail"] == "/experiment/models/preview/loras/0/foo.safetensors"


def test_sanitize_name_rules() -> None:
    assert cnode.sanitize_name("Anima: Detailer, v2", "FB12FB7B90") == "Anima Detailer v2"
    assert cnode.sanitize_name("vae", "FB12FB7B90") == "vae model"
    assert cnode.sanitize_name("  ", "FB12FB7B90") == "FB12FB7B90"


def test_emit_weightless_by_default_and_explicit_weight() -> None:
    assert cnode.format_entry("Anima Detailer", "CD64AF8696", None) == "Anima Detailer:CD64AF8696"
    assert (
        cnode.format_entry("Anima Detailer", "CD64AF8696", 0.8) == "Anima Detailer:CD64AF8696:0.8"
    )


def test_emit_all_decimal_hash_forces_weight() -> None:
    assert cnode.format_entry("X", "1234567890", None) == "X:1234567890:1.0"


def test_build_report_dedups_by_hash_lora_wins(tmp_path: Path) -> None:
    foo = tmp_path / "foo.safetensors"
    foo.write_bytes(b"abc")
    autov2 = hashlib.sha256(b"abc").hexdigest().upper()[:10]
    fetch = _fake_fetch(
        {
            "/api/v1/model-versions/by-hash/"
            + autov2: {
                "id": 1,
                "modelId": 2,
                "name": "v1",
                "model": {"name": "Foo", "type": "LORA"},
                "files": [{"id": 3, "hashes": {"AutoV2": autov2}}],
            }
        }
    )
    report = cnode.build_resource_report(
        loaded_loras="<lora:foo:0.8>",
        civitai_resources=autov2,
        lora_resolver=lambda name: str(foo) if name == "foo" else None,
        cache=cnode.ResolveCache(tmp_path / "c.json"),
        fetch=fetch,
    )
    assert report.additional_hashes == f"foo:{autov2}:0.8"  # single entry, lora weight kept
    payload = json.loads(report.resources_json)
    assert [e["status"] for e in payload] == ["resolved", "duplicate"]


def test_v2_schema_io() -> None:
    schema = cnode.CivitaiResourcesToHashMetadata.define_schema()
    assert schema.node_id == "CivitaiResourcesToHashMetadata"
    assert schema.display_name == "Civitai Resources To Hash Metadata"
    assert schema.category == "utils/metadata"
    assert [item.name for item in schema.inputs] == ["loaded_loras", "civitai_resources"]
    assert schema.inputs[0].force_input is True
    assert schema.inputs[0].optional is True
    assert schema.inputs[1].multiline is True
    assert [item.name for item in schema.outputs] == [
        "additional_hashes",
        "resolved",
        "missing",
        "resources_json",
    ]
    assert schema.is_output_node is True


def test_v2_execute_returns_ui_payload(tmp_path: Path, monkeypatch) -> None:
    cache_cls = cnode.ResolveCache
    monkeypatch.setattr(cnode, "ResolveCache", lambda: cache_cls(tmp_path / "c.json"))
    monkeypatch.setattr(cnode, "default_fetch", _fake_fetch({}))

    output = cnode.CivitaiResourcesToHashMetadata.execute(
        loaded_loras="", civitai_resources="not a url"
    )

    resources_json = output.args[3]
    assert output.args[:3] == ("", "", "not a url")
    payload = json.loads(resources_json)
    assert len(payload) == 1
    assert payload[0]["status"] == "missing"
    assert output.ui == {
        "civitai_resources_status": [resources_json],
        "civitai_resources_input": ["not a url"],
    }


def test_build_report_soft_fails_and_escapes_missing(tmp_path: Path) -> None:
    report = cnode.build_resource_report(
        loaded_loras="",
        civitai_resources="https://civitai.com/models/999999999\nnot,a url",
        lora_resolver=lambda name: None,
        cache=cnode.ResolveCache(tmp_path / "c.json"),
        fetch=_fake_fetch({}),
    )
    assert report.additional_hashes == ""
    assert report.missing == "https://civitai.com/models/999999999,not\\,a url"
    payload = json.loads(report.resources_json)
    assert all(e["status"] == "missing" and e["error"] for e in payload)


def test_preview_resources_json_excludes_loras_and_resolves(tmp_path: Path) -> None:
    fetch = _fake_fetch({"/api/v1/model-versions/3114726": VERSION_3114726})
    url_line = "https://civitai.com/models/2767064?modelVersionId=3114726"
    text = f"# a comment\n\n{url_line}\n"
    out = cnode.preview_resources_json(
        text,
        cache=cnode.ResolveCache(tmp_path / "c.json"),
        fetch=fetch,
    )
    payload = json.loads(out)
    # loaded_loras is unknown at preview time, so no lora entries leak in.
    assert len(payload) == 1
    assert all(e["kind"] != "lora" for e in payload)
    assert payload[0]["source"] == url_line
    assert payload[0]["status"] == "resolved"


def test_preview_resources_json_marks_duplicate(tmp_path: Path) -> None:
    hash_payload = {
        "id": 3114726,
        "modelId": 2767064,
        "name": "v0_8",
        "model": {"name": "Anima Detailer", "type": "LORA"},
        "files": [{"id": 2994936, "hashes": {"AutoV2": "CD64AF8696"}}],
    }
    fetch = _fake_fetch(
        {
            "/api/v1/model-versions/3114726": VERSION_3114726,
            "/api/v1/model-versions/by-hash/CD64AF8696": hash_payload,
        }
    )
    text = "https://civitai.com/models/2767064?modelVersionId=3114726\nCD64AF8696\n"
    out = cnode.preview_resources_json(
        text,
        cache=cnode.ResolveCache(tmp_path / "c.json"),
        fetch=fetch,
    )
    payload = json.loads(out)
    assert [e["status"] for e in payload] == ["resolved", "duplicate"]


def test_preview_resources_json_reports_missing(tmp_path: Path) -> None:
    url_line = "https://civitai.com/models/999999999"
    out = cnode.preview_resources_json(
        f"{url_line}\n",
        cache=cnode.ResolveCache(tmp_path / "c.json"),
        fetch=_fake_fetch({}),
    )
    payload = json.loads(out)
    assert len(payload) == 1
    assert payload[0]["status"] == "missing"
    assert payload[0]["source"] == url_line


def test_parse_rejects_oversized_ids_softly() -> None:
    huge = "9" * 5000  # would trip CPython's 4300-digit int-conversion limit
    lines = parse_resource_lines(
        f"https://civitai.com/models/{huge}\n"
        f"urn:air:sdxl:lora:civitai:{huge}@123\n"
        f"https://civitai.com/models/2767064?modelVersionId={huge}\n"
    )
    assert [line.kind for line in lines] == ["invalid", "invalid", "url"]
    assert lines[2].version_id is None  # junk pin ignored, url stays unpinned


def test_parse_preview_body_validation() -> None:
    ok = json.dumps({"text": "CD64AF8696"}).encode("utf-8")
    assert cnode._parse_preview_body(ok) == ("CD64AF8696", [], "")
    full = json.dumps(
        {"text": "x", "lora_hashes": ["D6A3AC6F8A"], "loaded_loras": "<lora:foo:1>"}
    ).encode("utf-8")
    assert cnode._parse_preview_body(full) == ("x", ["D6A3AC6F8A"], "<lora:foo:1>")
    assert cnode._parse_preview_body(b"not json") is None
    assert cnode._parse_preview_body(b'["text"]') is None
    assert cnode._parse_preview_body(b'{"text": 5}') is None
    assert cnode._parse_preview_body(b'{"text": "x", "lora_hashes": "D6"}') is None
    assert cnode._parse_preview_body(b'{"text": "x", "lora_hashes": [5]}') is None
    assert cnode._parse_preview_body(b'{"text": "x", "loaded_loras": 5}') is None
    long_hash = json.dumps({"text": "x", "lora_hashes": ["a" * 65]}).encode("utf-8")
    assert cnode._parse_preview_body(long_hash) is None
    assert cnode._parse_preview_body(b"\xff\xfe") is None
    too_many_lines = json.dumps({"text": "\n" * (cnode.PREVIEW_MAX_LINES + 1)}).encode("utf-8")
    assert cnode._parse_preview_body(too_many_lines) is None
    assert cnode._parse_preview_body(b" " * (cnode.PREVIEW_MAX_BYTES + 1)) is None


def test_preview_with_loaded_loras_includes_lora_rows_and_dedups(tmp_path: Path) -> None:
    foo = tmp_path / "foo.safetensors"
    foo.write_bytes(b"abc")
    autov2 = hashlib.sha256(b"abc").hexdigest().upper()[:10]
    hash_payload = {
        "id": 77,
        "modelId": 55,
        "name": "v1",
        "model": {"name": "Foo", "type": "LORA"},
        "files": [{"id": 1, "hashes": {"AutoV2": autov2}}],
    }
    out = cnode.preview_resources_json(
        autov2,  # textbox line duplicating the loaded lora
        cache=cnode.ResolveCache(tmp_path / "c.json"),
        fetch=_fake_fetch({f"/api/v1/model-versions/by-hash/{autov2}": hash_payload}),
        loaded_loras="<lora:foo:0.5>",
        lora_resolver=lambda name: str(foo) if name == "foo" else None,
    )
    payload = json.loads(out)
    kinds = [e["kind"] for e in payload]
    assert kinds == ["lora", "hash"]
    assert payload[0]["status"] == "resolved"
    assert payload[0]["hash"] == autov2
    assert payload[1]["status"] == "duplicate"  # run-parity dedup, lora wins


def test_preview_seeded_lora_hashes_mark_duplicates(tmp_path: Path) -> None:
    fetch = _fake_fetch({"/api/v1/model-versions/3114726": VERSION_3114726})
    out = cnode.preview_resources_json(
        "https://civitai.com/models/2767064?modelVersionId=3114726",
        cache=cnode.ResolveCache(tmp_path / "c.json"),
        fetch=fetch,
        lora_hashes=["cd64af8696"],  # case-insensitive
    )
    (entry,) = json.loads(out)
    assert entry["status"] == "duplicate"


def test_execute_ui_echoes_textbox_input(monkeypatch) -> None:
    report = cnode.ResourceReport(
        additional_hashes="", resolved="", missing="", resources_json="[]"
    )
    monkeypatch.setattr(cnode, "build_resource_report", lambda *args, **kwargs: report)
    out = cnode.CivitaiResourcesToHashMetadata.execute(civitai_resources="THE TEXT")
    assert out.ui["civitai_resources_input"] == ["THE TEXT"]
    assert out.ui["civitai_resources_status"] == ["[]"]

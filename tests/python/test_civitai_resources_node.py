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

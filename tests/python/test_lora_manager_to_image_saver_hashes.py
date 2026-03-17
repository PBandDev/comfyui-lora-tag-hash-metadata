import hashlib
import types
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import lora_manager_to_image_saver_hashes as lora_hashes

from lora_manager_to_image_saver_hashes import (
    LoraManagerToImageSaverHashes,
    build_additional_hashes,
    parse_loaded_loras,
    resolve_lora_path,
    sha256_10,
)


def test_node_schema_exposes_expected_io() -> None:
    schema = LoraManagerToImageSaverHashes.define_schema()

    assert schema.node_id == "LoraManagerToImageSaverHashes"
    assert schema.display_name == "LoraManager To Image Saver Hashes"
    assert schema.category == "ImageSaver/utils"
    assert [item.name for item in schema.inputs] == ["loaded_loras"]
    assert [item.name for item in schema.outputs] == [
        "additional_hashes",
        "resolved_loras",
        "missing_loras",
    ]


def test_node_execute_wraps_hash_bridge_logic(
    tmp_path: Path,
    monkeypatch,
) -> None:
    foo = tmp_path / "foo.safetensors"
    foo.write_bytes(b"abc")

    folder_paths = types.SimpleNamespace(
        get_filename_list=lambda category: ["foo.safetensors"],
        get_full_path=lambda category, name: str(foo),
    )
    monkeypatch.setattr(lora_hashes, "folder_paths", folder_paths, raising=False)

    result = LoraManagerToImageSaverHashes.execute("<lora:foo:0.8> <lora:bar:1.2>")

    expected_hash = hashlib.sha256(b"abc").hexdigest().upper()[:10]
    assert result == (f"foo:{expected_hash}:0.8", "foo", "bar")


def test_parse_single_lora() -> None:
    assert parse_loaded_loras("<lora:foo:0.8>") == [("foo", 0.8)]


def test_parse_defaults_weight_to_one() -> None:
    assert parse_loaded_loras("<lora:foo>") == [("foo", 1.0)]


def test_parse_multiple_loras() -> None:
    assert parse_loaded_loras("<lora:foo:0.8> <lora:bar:1.2>") == [
        ("foo", 0.8),
        ("bar", 1.2),
    ]


def test_parse_ignores_malformed_loras() -> None:
    assert parse_loaded_loras("<lora:foo:abc> <lora:bar:0.8:extra>") == []


def test_parse_ignores_non_finite_weights() -> None:
    assert parse_loaded_loras("<lora:foo:nan> <lora:bar:inf> <lora:baz:-inf>") == []


def test_parse_ignores_blank_lora_names() -> None:
    assert parse_loaded_loras("<lora:   :0.8>") == []


def test_parse_ignores_names_with_commas() -> None:
    assert parse_loaded_loras("<lora:foo,bar:0.8> <lora:baz:1.2>") == [("baz", 1.2)]


def test_resolve_lora_path_uses_comfyui_lora_model_paths(monkeypatch) -> None:
    folder_paths = types.SimpleNamespace(
        get_filename_list=lambda category: ["nested/foo.safetensors", "bar.safetensors"],
        get_full_path=lambda category, name: f"C:/ComfyUI/models/loras/{name}",
    )
    monkeypatch.setattr(lora_hashes, "folder_paths", folder_paths, raising=False)

    assert resolve_lora_path("foo") == "C:/ComfyUI/models/loras/nested/foo.safetensors"


def test_build_additional_hashes_skips_missing_and_reports_them(tmp_path: Path) -> None:
    existing = tmp_path / "foo.safetensors"
    existing.write_bytes(b"abc")

    def resolver(name: str) -> str | None:
        if name == "foo":
            return str(existing)
        return None

    result = build_additional_hashes("<lora:foo:0.8> <lora:bar:1.2>", resolver)

    expected_hash = hashlib.sha256(b"abc").hexdigest().upper()[:10]
    assert result.additional_hashes == f"foo:{expected_hash}:0.8"
    assert result.resolved_loras == "foo"
    assert result.missing_loras == "bar"


def test_build_additional_hashes_skips_comma_bearing_names(tmp_path: Path) -> None:
    safe = tmp_path / "safe.safetensors"
    unsafe = tmp_path / "unsafe.safetensors"
    safe.write_bytes(b"safe")
    unsafe.write_bytes(b"unsafe")

    def resolver(name: str) -> str | None:
        mapping = {
            "safe": str(safe),
            "bad,name": str(unsafe),
        }
        return mapping.get(name)

    result = build_additional_hashes("<lora:bad,name:0.8> <lora:safe:1.2>", resolver)

    expected_hash = hashlib.sha256(b"safe").hexdigest().upper()[:10]
    assert result.additional_hashes == f"safe:{expected_hash}:1.2"
    assert result.resolved_loras == "safe"
    assert result.missing_loras == ""


def test_build_additional_hashes_uses_last_duplicate_and_joins_resolved_entries(
    tmp_path: Path,
) -> None:
    foo = tmp_path / "foo.safetensors"
    bar = tmp_path / "bar.safetensors"
    foo.write_bytes(b"abc")
    bar.write_bytes(b"xyz")

    def resolver(name: str) -> str | None:
        mapping = {
            "foo": str(foo),
            "bar": str(bar),
        }
        return mapping.get(name)

    result = build_additional_hashes(
        "<lora:foo:0.8> <lora:bar:1.2> <lora:foo:0.5>",
        resolver,
    )

    foo_hash = hashlib.sha256(b"abc").hexdigest().upper()[:10]
    bar_hash = hashlib.sha256(b"xyz").hexdigest().upper()[:10]
    assert result.additional_hashes == f"bar:{bar_hash}:1.2,foo:{foo_hash}:0.5"
    assert result.resolved_loras == "bar,foo"
    assert result.missing_loras == ""


def test_sha256_10_hashes_without_path_read_bytes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    target = tmp_path / "chunked.safetensors"
    payload = (b"chunk" * 2048) + b"tail"
    target.write_bytes(payload)

    def fail_read_bytes(self: Path) -> bytes:
        raise AssertionError("sha256_10 should stream file content")

    monkeypatch.setattr(Path, "read_bytes", fail_read_bytes)

    assert sha256_10(str(target)) == hashlib.sha256(payload).hexdigest().upper()[:10]

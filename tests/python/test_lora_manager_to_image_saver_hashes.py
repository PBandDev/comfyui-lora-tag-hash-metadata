from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from lora_manager_to_image_saver_hashes import build_additional_hashes, parse_loaded_loras


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


def test_build_additional_hashes_skips_missing_and_reports_them(tmp_path: Path) -> None:
    existing = tmp_path / "foo.safetensors"
    existing.write_bytes(b"abc")

    def resolver(name: str) -> str | None:
        if name == "foo":
            return str(existing)
        return None

    result = build_additional_hashes("<lora:foo:0.8> <lora:bar:1.2>", resolver)

    assert result.additional_hashes.count(":") == 2
    assert result.resolved_loras == "foo"
    assert result.missing_loras == "bar"

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from lora_manager_to_image_saver_hashes import parse_loaded_loras


def test_parse_single_lora() -> None:
    assert parse_loaded_loras("<lora:foo:0.8>") == [("foo", 0.8)]


def test_parse_defaults_weight_to_one() -> None:
    assert parse_loaded_loras("<lora:foo>") == [("foo", 1.0)]


def test_parse_multiple_loras() -> None:
    assert parse_loaded_loras("<lora:foo:0.8> <lora:bar:1.2>") == [
        ("foo", 0.8),
        ("bar", 1.2),
    ]

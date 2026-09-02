from dataclasses import dataclass
import hashlib
import importlib.util
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


class _FakeString:
    Type = str

    @staticmethod
    def Input(name: str, multiline: bool = False) -> _FakeStringPort:
        return _FakeStringPort(name=name, multiline=multiline)

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


class _FakeIO:
    ComfyNode = _FakeComfyNode
    Schema = _FakeSchema
    String = _FakeString


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


def _remove_fake_comfy_api() -> None:
    sys.modules.pop("comfy_api.v0_0_2", None)
    sys.modules.pop("comfy_api", None)


def _load_module_from_path(
    module_name: str,
    module_path: Path,
    *,
    package_root: Path | None = None,
):
    kwargs = {}
    if package_root is not None:
        kwargs["submodule_search_locations"] = [str(package_root)]
    spec = importlib.util.spec_from_file_location(module_name, module_path, **kwargs)
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
lora_hashes = _load_module_from_path(
    "lora_manager_to_image_saver_hashes",
    REPO_ROOT / "lora_manager_to_image_saver_hashes.py",
)
LoraManagerToImageSaverHashes = lora_hashes.LoraManagerToImageSaverHashes
build_additional_hashes = lora_hashes.build_additional_hashes
parse_loaded_loras = lora_hashes.parse_loaded_loras
resolve_lora_path = lora_hashes.resolve_lora_path
sha256_10 = lora_hashes.sha256_10


def _normalize_lora_reference(name: str) -> str:
    helper = getattr(lora_hashes, "normalize_lora_reference", None)
    assert helper is not None
    return helper(name)


def test_package_entrypoint_loads_via_package_import_path(monkeypatch) -> None:
    package_root = REPO_ROOT
    module_path = package_root / "__init__.py"

    _install_fake_comfy_api()
    monkeypatch.chdir(package_root.parent)
    monkeypatch.delitem(sys.modules, "lora_manager_to_image_saver_hashes", raising=False)
    monkeypatch.setattr(
        sys,
        "path",
        [entry for entry in sys.path if Path(entry or ".").resolve() != package_root],
    )

    module = _load_module_from_path(
        "test_lora_hash_bridge_package",
        module_path,
        package_root=package_root,
    )

    extension = module.comfy_entrypoint()
    assert type(extension).__name__ == "LoraHashBridgeExtension"


def test_package_disables_legacy_v1_mapping_exports(monkeypatch) -> None:
    package_root = REPO_ROOT
    module_path = package_root / "__init__.py"

    _install_fake_comfy_api()
    monkeypatch.chdir(package_root.parent)

    module = _load_module_from_path(
        "test_lora_hash_bridge_package_v3_exports",
        module_path,
        package_root=package_root,
    )

    assert module.NODE_CLASS_MAPPINGS is None
    assert module.NODE_DISPLAY_NAME_MAPPINGS is None


def test_import_requires_comfy_api_module() -> None:
    module_path = REPO_ROOT / "lora_manager_to_image_saver_hashes.py"

    _remove_fake_comfy_api()
    try:
        with pytest.raises(ModuleNotFoundError, match="comfy_api"):
            _load_module_from_path("test_lora_hash_bridge_missing_api", module_path)
    finally:
        _install_fake_comfy_api()


def test_node_schema_exposes_expected_io() -> None:
    schema = LoraManagerToImageSaverHashes.define_schema()

    assert schema.node_id == "LoraTagsToHashMetadata"
    assert schema.display_name == "LoRA Tags To Hash Metadata"
    assert schema.category == "utils/metadata"
    assert [item.name for item in schema.inputs] == ["loaded_loras"]
    assert [item.name for item in schema.outputs] == [
        "additional_hashes",
        "resolved_loras",
        "missing_loras",
        "lora_hashes",
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
    assert result == (
        f"foo:{expected_hash}:0.8",
        "foo",
        "bar",
        f'Lora hashes: "foo: {expected_hash}"',
    )


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
    assert parse_loaded_loras("<lora:foo:abc> <lora:bar:1:2:3>") == []


def test_parse_dual_strength_credits_model_weight() -> None:
    # LoRA Manager emits <lora:name:model:clip> when the strengths differ;
    # the clip segment is ignored, the model strength is the credited weight.
    assert parse_loaded_loras("<lora:foo:0.8:0.5> <lora:bar:0.7:junk>") == [
        ("foo", 0.8),
        ("bar", 0.7),
    ]


def test_parse_ignores_non_finite_weights() -> None:
    assert parse_loaded_loras("<lora:foo:nan> <lora:bar:inf> <lora:baz:-inf>") == []


def test_parse_ignores_blank_lora_names() -> None:
    assert parse_loaded_loras("<lora:   :0.8>") == []


def test_parse_ignores_names_with_commas() -> None:
    assert parse_loaded_loras("<lora:foo,bar:0.8> <lora:baz:1.2>") == [
        ("foo,bar", 0.8),
        ("baz", 1.2),
    ]


def test_resolve_lora_path_uses_comfyui_lora_model_paths(monkeypatch) -> None:
    folder_paths = types.SimpleNamespace(
        get_filename_list=lambda category: ["nested/foo.safetensors", "bar.safetensors"],
        get_full_path=lambda category, name: f"C:/ComfyUI/models/loras/{name}",
    )
    monkeypatch.setattr(lora_hashes, "folder_paths", folder_paths, raising=False)

    assert resolve_lora_path("foo") == "C:/ComfyUI/models/loras/nested/foo.safetensors"


def test_resolve_lora_path_prefers_exact_relative_path_before_stem(monkeypatch) -> None:
    folder_paths = types.SimpleNamespace(
        get_filename_list=lambda category: [
            "other/foo.safetensors",
            "nested/foo.safetensors",
        ],
        get_full_path=lambda category, name: f"C:/ComfyUI/models/loras/{name}",
    )
    monkeypatch.setattr(lora_hashes, "folder_paths", folder_paths, raising=False)

    assert resolve_lora_path("nested/foo") == "C:/ComfyUI/models/loras/nested/foo.safetensors"


def test_resolve_lora_path_matches_basename_with_dotted_version_suffix(monkeypatch) -> None:
    folder_paths = types.SimpleNamespace(
        get_filename_list=lambda category: [
            "Anima/base model/anima_preview2_rdbt_finetuned_cfg_distilled_v0.23.safetensors",
        ],
        get_full_path=lambda category, name: f"C:/ComfyUI/models/loras/{name}",
    )
    monkeypatch.setattr(lora_hashes, "folder_paths", folder_paths, raising=False)

    assert resolve_lora_path("anima_preview2_rdbt_finetuned_cfg_distilled_v0.23") == (
        "C:/ComfyUI/models/loras/Anima/base model/"
        "anima_preview2_rdbt_finetuned_cfg_distilled_v0.23.safetensors"
    )


def test_resolve_lora_path_matches_relative_path_with_dotted_version_suffix(
    monkeypatch,
) -> None:
    folder_paths = types.SimpleNamespace(
        get_filename_list=lambda category: [
            "Anima/base model/anima_preview2_rdbt_finetuned_cfg_distilled_v0.23.safetensors",
            "Anima/base model/anima_preview2_rdbt_finetuned_cfg_distilled_v0.24.safetensors",
        ],
        get_full_path=lambda category, name: f"C:/ComfyUI/models/loras/{name}",
    )
    monkeypatch.setattr(lora_hashes, "folder_paths", folder_paths, raising=False)

    assert resolve_lora_path(
        "Anima/base model/anima_preview2_rdbt_finetuned_cfg_distilled_v0.23"
    ) == (
        "C:/ComfyUI/models/loras/Anima/base model/"
        "anima_preview2_rdbt_finetuned_cfg_distilled_v0.23.safetensors"
    )


def test_resolve_lora_path_still_matches_simple_name_without_extension(monkeypatch) -> None:
    folder_paths = types.SimpleNamespace(
        get_filename_list=lambda category: ["nested/foo.safetensors"],
        get_full_path=lambda category, name: f"C:/ComfyUI/models/loras/{name}",
    )
    monkeypatch.setattr(lora_hashes, "folder_paths", folder_paths, raising=False)

    assert resolve_lora_path("foo") == "C:/ComfyUI/models/loras/nested/foo.safetensors"


def test_resolve_lora_path_prefers_exact_relative_match_over_basename_fallback_with_versions(
    monkeypatch,
) -> None:
    folder_paths = types.SimpleNamespace(
        get_filename_list=lambda category: [
            "Other/anima_preview2_rdbt_finetuned_cfg_distilled_v0.23.safetensors",
            "Anima/base model/anima_preview2_rdbt_finetuned_cfg_distilled_v0.23.safetensors",
        ],
        get_full_path=lambda category, name: f"C:/ComfyUI/models/loras/{name}",
    )
    monkeypatch.setattr(lora_hashes, "folder_paths", folder_paths, raising=False)

    assert resolve_lora_path(
        "Anima/base model/anima_preview2_rdbt_finetuned_cfg_distilled_v0.23"
    ) == (
        "C:/ComfyUI/models/loras/Anima/base model/"
        "anima_preview2_rdbt_finetuned_cfg_distilled_v0.23.safetensors"
    )


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


def test_build_additional_hashes_resolves_dotted_version_lora_name(tmp_path: Path) -> None:
    target = tmp_path / "anima_preview2_rdbt_finetuned_cfg_distilled_v0.23.safetensors"
    target.write_bytes(b"anima")

    def resolver(name: str) -> str | None:
        if name == "anima_preview2_rdbt_finetuned_cfg_distilled_v0.23":
            return str(target)
        return None

    result = build_additional_hashes(
        "<lora:anima_preview2_rdbt_finetuned_cfg_distilled_v0.23:1>",
        resolver,
    )

    expected_hash = hashlib.sha256(b"anima").hexdigest().upper()[:10]
    assert result.additional_hashes == (
        f"anima_preview2_rdbt_finetuned_cfg_distilled_v0.23:{expected_hash}:1.0"
    )
    assert result.resolved_loras == "anima_preview2_rdbt_finetuned_cfg_distilled_v0.23"
    assert result.missing_loras == ""


def test_build_additional_hashes_reports_comma_bearing_names_as_missing(
    tmp_path: Path,
) -> None:
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
    assert result.missing_loras == r"bad\,name"


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


def test_execute_resolves_actual_loaded_loras_shape_with_dotted_version(
    monkeypatch,
) -> None:
    folder_paths = types.SimpleNamespace(
        get_filename_list=lambda category: [
            "Anima/base model/anima_preview2_rdbt_finetuned_cfg_distilled_v0.23.safetensors",
        ],
        get_full_path=lambda category, name: f"C:/ComfyUI/models/loras/{name}",
    )
    monkeypatch.setattr(lora_hashes, "folder_paths", folder_paths, raising=False)
    monkeypatch.setattr(
        lora_hashes,
        "sha256_10",
        lambda path: "F7180E92E5",
        raising=False,
    )

    assert LoraManagerToImageSaverHashes.execute(
        "<lora:anima_preview2_rdbt_finetuned_cfg_distilled_v0.23:1>"
    ) == (
        "anima_preview2_rdbt_finetuned_cfg_distilled_v0.23:F7180E92E5:1.0",
        "anima_preview2_rdbt_finetuned_cfg_distilled_v0.23",
        "",
        'Lora hashes: "anima_preview2_rdbt_finetuned_cfg_distilled_v0.23: F7180E92E5"',
    )


def test_normalize_lora_reference_preserves_dotted_version_without_known_extension() -> None:
    assert _normalize_lora_reference("anima_preview2_rdbt_finetuned_cfg_distilled_v0.23") == (
        "anima_preview2_rdbt_finetuned_cfg_distilled_v0.23"
    )


def test_normalize_lora_reference_strips_known_model_extension_only() -> None:
    assert _normalize_lora_reference(
        "Anima/base model/anima_preview2_rdbt_finetuned_cfg_distilled_v0.23.safetensors"
    ) == "anima/base model/anima_preview2_rdbt_finetuned_cfg_distilled_v0.23"


def test_v1_result_gains_structured_entries(tmp_path: Path) -> None:
    foo = tmp_path / "foo.safetensors"
    foo.write_bytes(b"abc")

    result = build_additional_hashes(
        "<lora:foo:0.8> <lora:bar:1.2>",
        lambda name: str(foo) if name == "foo" else None,
    )

    expected_hash = hashlib.sha256(b"abc").hexdigest().upper()[:10]
    assert result.entries[0] == {
        "kind": "lora",
        "name": "foo",
        "hash": expected_hash,
        "weight": 0.8,
        "status": "resolved",
    }
    assert result.entries[1] == {
        "kind": "lora",
        "name": "bar",
        "status": "missing",
        "error": "not found in loras folders",
    }


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


def test_lora_hashes_fragment_quotes_and_separators(tmp_path: Path) -> None:
    foo = tmp_path / "foo.safetensors"
    bar = tmp_path / "bar.safetensors"
    foo.write_bytes(b"abc")
    bar.write_bytes(b"xyz")

    result = build_additional_hashes(
        "<lora:foo:0.8> <lora:bar:1.2>",
        lambda name: {"foo": str(foo), "bar": str(bar)}.get(name),
    )

    foo_hash = hashlib.sha256(b"abc").hexdigest().upper()[:10]
    bar_hash = hashlib.sha256(b"xyz").hexdigest().upper()[:10]
    # A1111 grammar: quoted, `, ` between entries, `: ` between name and hash,
    # no weights, no leading comma (Image Saver prepends its own).
    assert result.lora_hashes == f'Lora hashes: "foo: {foo_hash}, bar: {bar_hash}"'


def test_lora_hashes_dedup_matches_additional_hashes_order(tmp_path: Path) -> None:
    foo = tmp_path / "foo.safetensors"
    bar = tmp_path / "bar.safetensors"
    foo.write_bytes(b"abc")
    bar.write_bytes(b"xyz")

    result = build_additional_hashes(
        "<lora:foo:0.8> <lora:bar:1.2> <lora:foo:0.5>",
        lambda name: {"foo": str(foo), "bar": str(bar)}.get(name),
    )

    foo_hash = hashlib.sha256(b"abc").hexdigest().upper()[:10]
    bar_hash = hashlib.sha256(b"xyz").hexdigest().upper()[:10]
    assert result.lora_hashes == f'Lora hashes: "bar: {bar_hash}, foo: {foo_hash}"'


def test_lora_hashes_empty_when_nothing_resolved() -> None:
    assert build_additional_hashes("", lambda name: None).lora_hashes == ""
    assert build_additional_hashes("<lora:bar:1.2>", lambda name: None).lora_hashes == ""


def test_format_lora_hashes_strips_quote_comma_colon_from_names() -> None:
    # Mirrors A1111's str.maketrans('', '', ':,') plus the quote that would
    # terminate the quoted value early.
    assert lora_hashes.format_lora_hashes([('a"b:c,d', "ABCDEF1234")]) == (
        'Lora hashes: "abcd: ABCDEF1234"'
    )


def test_format_lora_hashes_collapses_whitespace_to_single_line() -> None:
    assert lora_hashes.format_lora_hashes([("foo\nbar", "ABCDEF1234")]) == (
        'Lora hashes: "foo bar: ABCDEF1234"'
    )


def test_format_lora_hashes_never_appends_weight_even_for_decimal_hash() -> None:
    # additional_hashes pins `:1.0` on all-decimal hashes for Image Saver;
    # the 3-field form breaks every Lora hashes reader, so never here.
    assert lora_hashes.format_lora_hashes([("x", "1234567890")]) == (
        'Lora hashes: "x: 1234567890"'
    )


def test_format_lora_hashes_falls_back_to_hash_when_name_empties() -> None:
    assert lora_hashes.format_lora_hashes([('":,', "ABCDEF1234")]) == (
        'Lora hashes: "ABCDEF1234: ABCDEF1234"'
    )


def test_format_lora_hashes_avoids_civitai_truncation_tokens() -> None:
    out = lora_hashes.format_lora_hashes(
        [
            ("My Resources", "AAAAAAAAAA"),
            ("Hashed prompt", "BBBBBBBBBB"),
            ("Hashed Negative prompt", "CCCCCCCCCC"),
        ]
    )
    # civitai truncates the whole settings line at the first of these.
    for token in ("Resources: ", "Hashed prompt: ", "Hashed Negative prompt: "):
        assert token not in out
    for autov2 in ("AAAAAAAAAA", "BBBBBBBBBB", "CCCCCCCCCC"):
        assert f": {autov2}" in out


def test_lora_hashes_uses_resolved_file_stem_not_tag_path(tmp_path: Path) -> None:
    foo = tmp_path / "foo.safetensors"
    foo.write_bytes(b"abc")

    result = build_additional_hashes(
        "<lora:nested/foo:0.8>",
        lambda name: str(foo) if name == "nested/foo" else None,
    )

    foo_hash = hashlib.sha256(b"abc").hexdigest().upper()[:10]
    # A1111 keys Lora hashes by the file's bare stem; the tag's path form is
    # kept only where it always was (additional_hashes / resolved_loras).
    assert result.additional_hashes == f"nested/foo:{foo_hash}:0.8"
    assert result.lora_hashes == f'Lora hashes: "foo: {foo_hash}"'


def test_lora_hashes_dedups_tags_that_resolve_to_the_same_file(tmp_path: Path) -> None:
    foo = tmp_path / "foo.safetensors"
    foo.write_bytes(b"abc")

    result = build_additional_hashes(
        "<lora:foo:1> <lora:Foo:0.5>",
        lambda name: str(foo) if name.lower() == "foo" else None,
    )

    foo_hash = hashlib.sha256(b"abc").hexdigest().upper()[:10]
    assert result.lora_hashes == f'Lora hashes: "foo: {foo_hash}"'

"""Harness-only pack: MODEL source without any checkpoint download."""
import types

import torch
import torch.nn as nn

import comfy.model_patcher


class _StubUnet(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.model_config = types.SimpleNamespace(unet_config={})


class E2EDummyModel:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "create"
    CATEGORY = "e2e"

    def create(self):
        patcher = comfy.model_patcher.ModelPatcher(
            _StubUnet(),
            load_device=torch.device("cpu"),
            offload_device=torch.device("cpu"),
        )
        return (patcher,)


NODE_CLASS_MAPPINGS = {"E2EDummyModel": E2EDummyModel}
NODE_DISPLAY_NAME_MAPPINGS = {"E2EDummyModel": "E2E Dummy Model"}

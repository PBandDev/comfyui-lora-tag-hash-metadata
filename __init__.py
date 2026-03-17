if __package__:
    from .lora_manager_to_image_saver_hashes import comfy_entrypoint
else:
    from lora_manager_to_image_saver_hashes import comfy_entrypoint

WEB_DIRECTORY = "./dist"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "comfy_entrypoint",
]

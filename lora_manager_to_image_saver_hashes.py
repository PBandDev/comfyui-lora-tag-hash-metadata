import re


LORA_PATTERN = re.compile(r"<lora:([^>:]+)(?::([^>]+))?>", re.IGNORECASE)


def parse_loaded_loras(value: str) -> list[tuple[str, float]]:
    parsed: list[tuple[str, float]] = []
    for name, raw_weight in LORA_PATTERN.findall(value or ""):
        try:
            weight = float((raw_weight or "1.0").split(":")[0])
        except ValueError:
            weight = 1.0
        parsed.append((name.strip(), weight))
    return parsed

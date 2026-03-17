import re


LORA_PATTERN = re.compile(r"<lora:([^:>]+)(?::([^:>]+))?>", re.IGNORECASE)


def parse_loaded_loras(value: str) -> list[tuple[str, float]]:
    parsed: list[tuple[str, float]] = []
    for name, raw_weight in LORA_PATTERN.findall(value or ""):
        if raw_weight is None or raw_weight == "":
            weight = 1.0
        else:
            try:
                weight = float(raw_weight.strip())
            except ValueError:
                continue
        parsed.append((name.strip(), weight))
    return parsed

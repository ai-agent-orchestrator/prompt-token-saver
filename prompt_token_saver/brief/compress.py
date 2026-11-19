"""Conservative rules R1-R5; no clause truncation."""
import re
from .normalize import C, markers
ENDINGS = [("했습니다.", "했음."), ("있습니다.", "있음."), ("없습니다.", "없음."), ("합니다.", "함."), ("입니다.", "임."), ("됩니다.", "됨."), ("한다.", "함."), ("이다.", "임."), ("된다.", "됨."), ("있다.", "있음."), ("없다.", "없음.")]
def compress(text, keep_terms=()):
    value = re.sub(r"^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)", "", text)
    value = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"\*\*|__|`", "", value)
    value = re.sub(r"\([^()]*\)|\[[^\[\]]*\]", lambda m: m[0] if re.search(r"\d", m[0]) or markers(m[0], C["NEGATION"]+C["CONDITION"]+list(keep_terms)) else "", value)
    value = re.sub(r"\s+", " ", value).strip()
    value = re.sub(r"^(?:또한, |그리고 |참고로 |한편 |기본적으로 )", "", value)
    for before, after in ENDINGS:
        if value.endswith(before):
            return value[:-len(before)]+after
    return value

def extract(group, budget, keep_terms=(), candidates=None):
    selected, used = [], 0
    for s in sorted((s for s in (group["sentences"] if candidates is None else candidates) if not s["duplicate"] and s["score"] >= 0), key=lambda s: (-s["score"], s["order"])):
        text = compress(s["text"], keep_terms)
        cost = len(text)+(1 if selected else 0)
        if text and used+cost <= budget:
            selected.append((s, text))
            used += cost
    return " ".join(text for s, text in sorted(selected, key=lambda item: item[0]["order"]))

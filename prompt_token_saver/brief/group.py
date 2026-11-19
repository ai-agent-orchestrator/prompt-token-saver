"""Sequential bounded topic groups."""
from .normalize import C, grams

def group(sentences):
    groups, current, previous = [], None, None
    for sentence in sentences:
        next_grams = grams(sentence["text"], 2)
        similarity = len(next_grams & previous)/max(1, len(next_grams | previous)) if previous is not None else 0
        if current is None or sentence["section"] != current["section"] or current["size"]+len(sentence["text"])+1 > C["MAX_GROUP_CP"] or len(current["sentences"]) >= C["MAX_GROUP_SENT"] or (not sentence["title"] and similarity < C["GROUP_SIM"]):
            current = {"id": f"g{len(groups)+1}", "title": sentence["title"] or f"주제 {len(groups)+1}", "section": sentence["section"], "sentences": [], "size": 0, "order": sentence["order"]}
            groups.append(current)
        current["sentences"].append(sentence)
        current["size"] += len(sentence["text"])+(1 if len(current["sentences"]) > 1 else 0)
        previous = next_grams
    return groups

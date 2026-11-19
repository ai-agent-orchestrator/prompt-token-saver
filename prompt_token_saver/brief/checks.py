"""Rule-based grounding, relational anchors, and length checks in parallel."""
import re
from concurrent.futures import ThreadPoolExecutor
from .normalize import C, grams, containment, markers
from .segment import split_sentences
from ..text import strip_josa
POLLUTED = re.compile(r"^\s*(?:#|[-*•]\s|\d+[.)]\s)|상태:|근거:|조사 요청|코드포인트\s*\[|[{}]|\[\d+,\s*\d+\)", re.M)
NUMBER = re.compile(r"[$€£¥₩]?[+-]?(?:[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|\.[0-9]+)(?:\s*%|[a-zA-Z]+|[가-힣]+)?")
def numbers(text):
    result = []
    for m in NUMBER.finditer(text):
        value = re.sub(r"[,\s]", "", m[0].lower())
        part = re.fullmatch(r"([$€£¥₩]?)([+-]?(?:\d+(?:\.\d+)?|\.\d+))(.*)", value)
        numeric = part[2].removeprefix("+")
        numeric = re.sub(r"^(-?)0+(?=\d)", r"\1", numeric)
        numeric = re.sub(r"(\.\d*?)0+$", r"\1", numeric).removesuffix(".")
        if re.fullmatch(r"-?0(?:\.0*)?", numeric):
            numeric = "0"
        result.append({"text": m[0], "norm": part[1]+numeric+strip_josa(part[3]), "start": m.start(), "end": m.end()})
    return result

def match_sentences(candidate, group):
    matches = []
    for part in split_sentences(candidate):
        query = grams(part["text"])
        best, best_score = None, -1
        for s in group["sentences"]:
            value = containment(query, s.get("grams", grams(s["text"])))
            if value > best_score:
                best, best_score = s, value
        matches.append({"text": part["text"], "source": best, "score": best_score})
    return matches

def check_meaning(candidate, group, method, thresholds=None):
    if not candidate.strip():
        return {"result": "FAIL", "reason": "EMPTY", "matches": []}
    if POLLUTED.search(candidate):
        return {"result": "FAIL", "reason": "BODY_FORMAT", "matches": []}
    matches = match_sentences(candidate, group)
    threshold = (thresholds or {}).get(method, C["TAU_A_MODEL"] if method == "model" else C["TAU_A_EXTRACT"])
    reason = None
    for m in matches:
        if m["source"] is None:
            reason = "NO_SOURCE"
        elif markers(m["text"], C["NEGATION"]) != markers(m["source"]["text"], C["NEGATION"]):
            reason = "NEGATION_CHANGED"
        elif any(v not in markers(m["text"], C["CONDITION"]) for v in markers(m["source"]["text"], C["CONDITION"])):
            reason = "CONDITION_DROPPED"
        elif m["score"] < threshold:
            reason = "LOW_CONTAINMENT"
        if reason:
            break
    return {"result": "FAIL" if reason else "PASS", "reason": reason, "threshold": threshold, "matches": [{"sentenceId": m["source"]["id"] if m["source"] else None, "text": m["text"], "score": m["score"], "span": m["source"]["span"] if m["source"] else None} for m in matches]}

def check_anchors(candidate, group, keep_terms=()):
    matched, records = match_sentences(candidate, group), []
    reason = None if candidate.strip() else "EMPTY"
    for m in matched:
        if not m["source"]:
            reason = reason or "NO_SOURCE"
            continue
        source = m["source"]["text"]
        original, selected = numbers(source), numbers(m["text"])
        norms = {n["norm"] for n in selected}
        for n in selected:
            original_number = next((x for x in original if x["norm"] == n["norm"]), None)
            records.append({"text": n["text"], "sourceSentence": m["source"]["id"]})
            if not original_number:
                reason = reason or "NUMBER_NOT_IN_SOURCE"
                continue
            boundaries = [b.start() for b in re.finditer(r",|며|고", source)]
            left = max([-1]+[i for i in boundaries if i < original_number["start"]])
            right = next((i for i in boundaries if i > original_number["end"]), len(source))
            if any(left < x["start"] < right and x["norm"] not in norms for x in original):
                reason = reason or "NUMBER_RELATION_BROKEN"
            before = re.findall(r"[A-Za-z_]+|[가-힣]+", source[left+1:original_number["start"]])[-2:]
            candidate_words = {strip_josa(w).lower() for w in re.findall(r"[A-Za-z_]+|[가-힣]+", m["text"])}
            if any(strip_josa(w).lower() not in candidate_words for w in before):
                reason = reason or "SUBJECT_DETACHED"
        source_names = set(re.findall(r"\b[A-Z][A-Za-z_0-9]+\b", source, re.ASCII))
        if any(n not in source_names for n in re.findall(r"\b[A-Z][A-Za-z_0-9]+\b", m["text"], re.ASCII)):
            reason = reason or "NAME_NOT_IN_SOURCE"
    for term in keep_terms:
        if any(term in s["text"] for s in group["sentences"]) and term not in candidate:
            reason = reason or "KEEP_TERM_DROPPED"
    return {"result": "FAIL" if reason else "PASS", "reason": reason, "numbers": records}

def check_length(candidate, limit):
    return {"result": "PASS" if len(candidate) <= limit else "FAIL", "reason": None if len(candidate) <= limit else "OVER_BUDGET", "cp": len(candidate), "limit": limit}

def checks(candidate, group, method, budget, keep_terms=(), thresholds=None):
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(check_meaning, candidate, group, method, thresholds), pool.submit(check_anchors, candidate, group, keep_terms), pool.submit(check_length, candidate, budget)]
        return dict(zip(("meaning", "anchor", "length"), (f.result() for f in futures)))

def accepted(verdict):
    return all(v["result"] == "PASS" for v in verdict.values()) and len(verdict) == 3

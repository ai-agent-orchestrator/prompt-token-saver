"""Deterministic TF-IDF centroid ranking and bounded budget allocation."""
import math
import re
from collections import Counter, defaultdict
from .normalize import C, grams, markers

def score(sentences, keep_terms=()):
    counts, postings, seen = Counter(), defaultdict(list), set()
    for s in sentences:
        s["grams"] = grams(s["text"])
        s["excluded"] = bool(re.fullmatch(r"(?:맞습니다[.!]?|네[.!]?|단순히 .*이유는 명확합니다[.!]?|왜 .*인가[?？]|.*(?:정리해 드릴까요|도와드릴까요)[?？])", s["text"]))
        s["duplicate"] = s["text"] in seen
        if not s["duplicate"]:
            possible = Counter(i for gram in s["grams"] for i in postings[gram])
            s["duplicate"] = any(common/max(1, min(len(s["grams"]), len(sentences[i]["grams"]))) >= C["DUP_CONTAINMENT"] for i, common in possible.items())
        if s["duplicate"] or s["excluded"]:
            continue
        seen.add(s["text"])
        for gram in s["grams"]:
            postings[gram].append(s["order"])
        s["terms"] = re.findall(r"[가-힣]+|[a-z]+|[0-9]+", s["text"].lower())
        counts.update(set(s["terms"]))
    unique = [s for s in sentences if not s["duplicate"] and not s["excluded"]]
    centroid = Counter()
    for s in unique:
        s["vector"] = [(term, n*(math.log((len(unique)+1)/(counts[term]+1))+1)) for term, n in Counter(s["terms"]).items()]
        for term, value in s["vector"]:
            centroid[term] += value
    norm = math.sqrt(sum(v*v for v in centroid.values()))
    for s in sentences:
        if s["duplicate"] or s["excluded"]:
            s["score"] = -1
            continue
        dot = sum(v*centroid[t] for t, v in s["vector"])
        local = math.sqrt(sum(v*v for _, v in s["vector"]))
        anchors = len(re.findall(r"\d+", s["text"]))+len(markers(s["text"], C["NEGATION"]+C["CONDITION"]))+sum(t in s["text"] for t in keep_terms)
        s["score"] = round(dot/(local*norm or 1)+0.3*anchors/max(1, len(s["text"]))+(0.2 if s["first"] else 0), 12)

def rank_groups(groups):
    for g in groups:
        top = sorted((s["score"] for s in g["sentences"] if not s["duplicate"] and s["score"] >= 0), reverse=True)[:3]
        g["weight"] = round(top[0]+0.5*sum(top)/len(top), 12) if top else 0
    return sorted((g for g in groups if g["weight"] > 0), key=lambda g: (-g["weight"], g["order"]))

def allocate(groups, budget):
    k = min(len(groups), (budget+1)//(C["MIN_GROUP_BUDGET"]+1))
    if not k:
        return []
    selected, available = groups[:k], budget-max(0, k-1)
    total = sum(g["weight"] for g in selected)
    residual = available-k*C["MIN_GROUP_BUDGET"]
    budgets = [{"group": g, "budget": C["MIN_GROUP_BUDGET"]+math.floor(residual*g["weight"]/total)} for g in selected]
    remaining = available-sum(x["budget"] for x in budgets)
    for i in range(remaining):
        budgets[i % k]["budget"] += 1
    return budgets

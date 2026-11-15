"""Check factual anchor retention using normalized whole words and numbers."""

from dataclasses import asdict
import math

from .surprise import Anchor, _kind, _norm, _words
from .types import CheckResult, Summary


def check_anchors(summary: str | Summary, anchors: list[Anchor],
                  max_missing_name_ratio: float = 0.2) -> CheckResult:
    """Report missing anchors and contextual numeric substitutions.

    Changed numbers are a subset of missing anchors and still fail the check.
    A substitution needs an equal immediate left or right context word in the
    same position. Without source context a missing number remains only missing.
    Score is occurrence coverage across all kinds; terms affect score, not pass.
    Names use a simple capitalization heuristic, not named-entity recognition.
    """
    if (not math.isfinite(max_missing_name_ratio)
            or not 0 <= max_missing_name_ratio <= 1):
        raise ValueError("max_missing_name_ratio must be finite and in [0, 1]")
    text = summary.text if isinstance(summary, Summary) else summary
    words = _words(text)
    norms = {_norm(word) for word, _, _ in words}
    missing = []
    changed = []
    for anchor in anchors:
        if anchor.kind != "number":
            if anchor.norm not in norms:
                missing.append(asdict(anchor))
            continue
        contextual = []
        for index, (word, start, end) in enumerate(words):
            if _kind(word) != "number":
                continue
            context = tuple(_norm(words[neighbor][0])
                            if 0 <= neighbor < len(words) else ""
                            for neighbor in (index - 1, index + 1))
            if any(source and source == target
                   for source, target in zip(anchor.context, context)):
                contextual.append({"text": word, "norm": _norm(word),
                                   "start": start, "end": end})
        # A number appearing elsewhere cannot hide a substitution in its context.
        if anchor.norm in norms and (not contextual or any(
                item["norm"] == anchor.norm for item in contextual)):
            continue
        missing.append(asdict(anchor))
        replacements = [item for item in contextual if item["norm"] != anchor.norm]
        if replacements:
            changed.append({"anchor": asdict(anchor), "replacements": replacements})
    missing_numbers = [item for item in missing if item["kind"] == "number"]
    missing_names = [item for item in missing if item["kind"] == "name"]
    name_count = sum(anchor.kind == "name" for anchor in anchors)
    name_ratio = len(missing_names) / name_count if name_count else 0.0
    return CheckResult(
        name="anchor", passed=not missing_numbers and name_ratio <= max_missing_name_ratio,
        score=1 - len(missing) / len(anchors) if anchors else 1.0,
        details={"missing": missing, "changed": changed,
                 "missing_numbers": missing_numbers, "missing_names": missing_names,
                 "missing_name_ratio": name_ratio,
                 "max_missing_name_ratio": max_missing_name_ratio},
    )

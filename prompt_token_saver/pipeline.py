"""Group, summarize and check local documents with auditable decisions."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path

from .check_anchor import check_anchors
from .check_meaning import check_meaning
from .group import group_chunks
from .summarize import ExtractiveSummarizer, _validate_limit
from .surprise import extract_anchors
from .text import chunk_text
from .types import CheckResult, ItemResult


@dataclass(frozen=True)
class RunItem(ItemResult):
    final_score: float


@dataclass(frozen=True)
class RunReport:
    items: list[RunItem]
    settings: dict
    token_counts: dict
    savings_rate: float
    decision_counts: dict[str, int]

    def to_json(self, path: str | Path) -> None:
        """Write a UTF-8 report; create its output directory if necessary."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2,
                                   allow_nan=False) + "\n", encoding="utf-8")


class _CachedEmbedder:
    """Reuse the source batch for extraction and grounding checks.

    New summary sentences still need embeddings. Only checker A uses this
    adapter in the worker pool; extraction and indexing run on the caller.
    """

    def __init__(self, embedder):
        self.embedder = embedder
        self.model_id = embedder.model_id
        self.cache = {}

    def embed(self, texts):
        missing = list(dict.fromkeys(text for text in texts if text not in self.cache))
        if missing:
            vectors = self.embedder.embed(missing)
            if len(vectors) != len(missing):
                raise ValueError("Text and vector counts must match")
            self.cache.update(zip(missing, vectors))
        return [self.cache[text] for text in texts]


def _identifier(component):
    return str(getattr(component, "model_id", None)
               or getattr(component, "model_name", None)
               or type(component).__name__)


def run(docs: dict[str, str], *, embedder, store, summarizer, scorer,
        meaning_rule, mode="both", weight=0.5, group_threshold=0.55,
        max_sentences=3) -> RunReport:
    """Check both signals in parallel, then apply mode independently of weight.

    A summarizer exception always selects extraction, including in flag mode.
    Scores and checks describe the candidate, while final_text is what is kept.
    Checker and infrastructure exceptions propagate instead of hiding failures.
    """
    if mode not in ("meaning", "anchor", "both", "flag"):
        raise ValueError("Unknown mode")
    if not math.isfinite(weight) or not 0 <= weight <= 1:
        raise ValueError("weight must be finite and in [0, 1]")
    _validate_limit(max_sentences)
    cached = _CachedEmbedder(embedder)
    chunks = [chunk for doc_id, text in docs.items() for chunk in chunk_text(doc_id, text)]
    vectors = cached.embed([chunk.text for chunk in chunks])
    store.add(chunks, vectors, model_id=embedder.model_id)
    groups = group_chunks(chunks, vectors, threshold=group_threshold)
    by_id = {chunk.id: chunk for chunk in chunks}
    extraction = ExtractiveSummarizer(cached)
    selected_summarizer = summarizer if summarizer is not None else extraction
    items = []
    with ThreadPoolExecutor(max_workers=2) as executor:
        for group in groups:
            sources = [by_id[chunk_id] for chunk_id in group.chunk_ids]
            try:
                summary = selected_summarizer.summarize(sources, max_sentences)
            except Exception:
                summary = extraction.summarize(sources, max_sentences)
                # Do not persist exception strings, which may contain private data.
                checks = [CheckResult("summarizer", False, 0.0,
                                      {"error": "summarizer_exception"})]
                decision, final_text, score = "fallback", summary.text, 0.0
            else:
                meaning = executor.submit(check_meaning, summary, sources, store,
                                          cached, meaning_rule)
                anchors = executor.submit(
                    lambda: check_anchors(summary, extract_anchors(
                        scorer.score("\n\n".join(chunk.text for chunk in sources)))))
                a, b = meaning.result(), anchors.result()
                checks = [a, b]
                score = (1 - weight) * a.score + weight * b.score
                passed = {"meaning": a.passed, "anchor": b.passed,
                          "both": a.passed and b.passed,
                          "flag": a.passed and b.passed}[mode]
                decision = "pass" if passed else "flag" if mode == "flag" else "fallback"
                final_text = (extraction.summarize(sources, max_sentences).text
                              if decision == "fallback" else summary.text)
            items.append(RunItem(group.id, group.chunk_ids, summary, checks,
                                 decision, final_text, score))
    original = sum(len(text.split()) for text in docs.values())
    final = sum(len(item.final_text.split()) for item in items)
    return RunReport(
        items=items,
        settings={"mode": mode, "weight": weight,
                  "meaning_rule": asdict(meaning_rule),
                  "threshold_version": meaning_rule.version,
                  "embedder_id": embedder.model_id, "scorer_id": _identifier(scorer),
                  "group_threshold": group_threshold, "max_sentences": max_sentences},
        token_counts={"original": original, "final": final,
                      "method": "공백 분리 근사"},
        savings_rate=1 - final / original if original else 0.0,
        decision_counts={name: sum(item.decision == name for item in items)
                         for name in ("pass", "flag", "fallback")},
    )

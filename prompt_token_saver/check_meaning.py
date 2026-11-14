"""Sentence grounding by cosine score and the gap between source matches."""

from dataclasses import asdict, dataclass
import math

from .embed import Embedder, cosine
from .store import VectorStore
from .types import CheckResult, Chunk, Summary


@dataclass(frozen=True)
class GapRule:
    """Versioned grounding thresholds and a display-only coverage threshold."""

    tau_abs: float
    tau_gap: float
    version: str
    coverage_min: float = 0.5

    def __post_init__(self) -> None:
        for name, low, high in (("tau_abs", -1, 1), ("tau_gap", 0, 2),
                                ("coverage_min", -1, 1)):
            value = getattr(self, name)
            if not math.isfinite(value) or not low <= value <= high:
                raise ValueError(f"{name} must be finite and in [{low}, {high}]")
        if not isinstance(self.version, str) or not self.version.strip():
            raise ValueError("version must be nonempty")

    @classmethod
    def default_for(cls, model_id: str) -> "GapRule":
        """보정 전 값, 보드에서 조정.

        Only the demo hash model has provisional conservative thresholds.
        Other embedding models require an explicitly calibrated rule.
        """
        prefix = "hash-unigram-char3-v1:"
        dimension = model_id.removeprefix(prefix)
        if not model_id.startswith(prefix) or not dimension.isdecimal() or int(dimension) < 1:
            raise ValueError("No default rule for this model_id; supply a calibrated GapRule")
        return cls(tau_abs=0.8, tau_gap=0.1,
                   version="hash-unigram-char3-v1-uncalibrated", coverage_min=0.5)


def _source_matches(store: VectorStore, vector: list[float],
                    source_ids: set[str]) -> list[tuple[str, float]]:
    """Expand retrieval when unrelated groups occupy the nearest positions."""
    if not source_ids:
        return []
    k = 2
    while True:
        hits = store.search(vector, k)
        matches = sorted((hit for hit in hits if hit[0] in source_ids),
                         key=lambda hit: (-hit[1], hit[0]))[:2]
        if len(matches) == min(2, len(source_ids)) or len(hits) < k:
            return matches
        k *= 2


def check_meaning(summary: Summary, source_chunks: list[Chunk], store: VectorStore,
                  embedder: Embedder, rule: GapRule) -> CheckResult:
    """Check a Summary against source chunks already indexed with this embedder.

    Details contain ordered sentence records (scores are None for absent hits),
    unsupported sentence strings, rule metadata and uncovered source candidates.
    Score is the supported sentence fraction, or 1.0 for an empty summary.
    Coverage never changes the grounding decision. The store is read-only.
    """
    source_ids = {chunk.id for chunk in source_chunks}
    if len(source_ids) != len(source_chunks):
        raise ValueError("Source chunk IDs must be unique")
    if source_chunks and store.model_id != embedder.model_id:
        raise ValueError("Embedding model_id does not match the index")
    for chunk in source_chunks:
        if store.get(chunk.id) != chunk:
            raise ValueError("Source chunk does not match the indexed chunk")

    texts = list(summary.sentences) + [chunk.text for chunk in source_chunks]
    vectors = embedder.embed(texts) if texts else []
    if len(vectors) != len(texts):
        raise ValueError("Text and vector counts must match")
    sentence_vectors = vectors[:len(summary.sentences)]
    source_vectors = vectors[len(summary.sentences):]
    records = []
    unsupported = []
    for index, (sentence, vector) in enumerate(zip(summary.sentences, sentence_vectors)):
        matches = _source_matches(store, vector, source_ids)
        top1 = matches[0][1] if matches else None
        top2 = matches[1][1] if len(matches) > 1 else None
        supported = (top1 is not None and top1 >= rule.tau_abs
                     and (len(source_chunks) == 1
                          or (top2 is not None and top1 - top2 >= rule.tau_gap)))
        records.append({"index": index, "sentence": sentence, "top1": top1,
                        "top2": top2, "chunk_id": matches[0][0] if matches else None,
                        "top2_chunk_id": matches[1][0] if top2 is not None else None,
                        "supported": supported})
        if not supported:
            unsupported.append(sentence)

    coverage = []
    for chunk, vector in zip(source_chunks, source_vectors):
        best = max((cosine(vector, sentence) for sentence in sentence_vectors), default=None)
        coverage.append({"chunk_id": chunk.id, "max_cosine": best,
                         "missing": best is None or best < rule.coverage_min})
    return CheckResult(
        name="meaning", passed=not unsupported,
        score=1.0 - len(unsupported) / len(records) if records else 1.0,
        details={"rule": asdict(rule), "model_id": embedder.model_id,
                 "sentences": records, "unsupported_sentences": unsupported,
                 "coverage": coverage,
                 "missing_core_candidates": [item for item in coverage if item["missing"]]},
    )

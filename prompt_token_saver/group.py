"""Deterministic average-link agglomeration without external dependencies."""

import hashlib
import json
import math

from .embed import _vector, cosine
from .types import Chunk, Group


def group_chunks(chunks: list[Chunk], vectors: list[list[float]],
                 threshold: float = 0.55, min_size: int = 1,
                 max_group_chars: int = 1200) -> list[Group]:
    """Merge the closest groups while average cosine meets threshold.

    Input order defines source order. Ties favor the earliest groups. Groups
    smaller than min_size are omitted after clustering. IDs hash ordered chunk
    IDs, independently of threshold and text content.
    """
    if not math.isfinite(threshold) or not -1.0 <= threshold <= 1.0:
        raise ValueError("threshold must be finite and between -1 and 1")
    if isinstance(max_group_chars, bool) or not isinstance(max_group_chars, int) or max_group_chars < 1:
        raise ValueError("max_group_chars must be a positive integer")
    if isinstance(min_size, bool) or not isinstance(min_size, int) or min_size < 1:
        raise ValueError("min_size must be a positive integer")
    if len(chunks) != len(vectors):
        raise ValueError("Chunk and vector counts must match")
    if len({chunk.id for chunk in chunks}) != len(chunks):
        raise ValueError("Chunk IDs must be unique")
    vectors = [_vector(vector) for vector in vectors]
    if vectors and any(len(vector) != len(vectors[0]) for vector in vectors):
        raise ValueError("Vector dimensions must match")
    similarities = {(i, j): cosine(vectors[i], vectors[j])
                    for i in range(len(vectors)) for j in range(i + 1, len(vectors))}
    clusters = [[i] for i in range(len(chunks))]
    while len(clusters) > 1:
        best_score, best_pair = -math.inf, None
        for i, left in enumerate(clusters):
            for j in range(i + 1, len(clusters)):
                right = clusters[j]
                if sum(len(chunks[k].text) for k in left + right) + len(left) + len(right) - 1 > max_group_chars:
                    continue
                score = math.fsum(similarities[min(a, b), max(a, b)]
                                  for a in left for b in right) / (len(left) * len(right))
                if score > best_score:
                    best_score, best_pair = score, (i, j)
        if best_score < threshold:
            break
        i, j = best_pair
        clusters[i] = sorted(clusters[i] + clusters[j])
        del clusters[j]
    result = []
    for cluster in clusters:
        if len(cluster) < min_size:
            continue
        ids = [chunks[i].id for i in cluster]
        digest = hashlib.sha256(json.dumps(ids, ensure_ascii=False).encode("utf-8")).hexdigest()
        result.append(Group("group:" + digest, ids))
    return result

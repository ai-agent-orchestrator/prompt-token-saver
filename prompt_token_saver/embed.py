"""Dependency-free embeddings and an injectable Ollama adapter."""

import hashlib
import json as jsonlib
import math
import re
from typing import Protocol
from urllib.request import Request, urlopen


class Embedder(Protocol):
    dim: int
    model_id: str

    def embed(self, texts: list[str]) -> list[list[float]]: ...


def _vector(values) -> list[float]:
    result = [float(value) for value in values]
    if not result or not all(math.isfinite(value) for value in result):
        raise ValueError("Vectors must be nonempty and finite")
    return result


def cosine(a: list[float], b: list[float]) -> float:
    """Return cosine similarity; a zero vector has similarity zero."""
    a, b = _vector(a), _vector(b)
    if len(a) != len(b):
        raise ValueError("Vector dimensions must match")
    # Scaling first also handles very large finite components safely.
    sa, sb = max(map(abs, a)), max(map(abs, b))
    if not sa or not sb:
        return 0.0
    a, b = [x / sa for x in a], [x / sb for x in b]
    score = math.fsum(x * y for x, y in zip(a, b)) / (
        math.sqrt(math.fsum(x * x for x in a))
        * math.sqrt(math.fsum(x * x for x in b))
    )
    return max(-1.0, min(1.0, score))


class HashEmbedder:
    """Deterministic demo/test features: 의미 모델이 아님.

    Token unigrams and character trigrams use separate hash namespaces.
    Empty text produces a zero vector.
    """

    def __init__(self, dim: int = 256):
        if isinstance(dim, bool) or not isinstance(dim, int) or dim < 1:
            raise ValueError("dim must be a positive integer")
        self.dim = dim
        self.model_id = f"hash-unigram-char3-v1:{dim}"

    def embed(self, texts: list[str]) -> list[list[float]]:
        result = []
        for text in texts:
            words = re.findall(r"\w+", text.casefold())
            normalized = " ".join(words)
            features = ["word:" + word for word in words]
            features.extend("char:" + normalized[i:i + 3]
                            for i in range(len(normalized) - 2))
            vector = [0.0] * self.dim
            for feature in features:
                digest = hashlib.sha256(feature.encode("utf-8")).digest()
                vector[int.from_bytes(digest[:8], "big") % self.dim] += 1.0
            norm = math.sqrt(sum(x * x for x in vector))
            result.append([x / norm for x in vector] if norm else vector)
        return result


class _UrllibHTTP:
    def post(self, url: str, json: dict) -> dict:
        # The adapter is deliberately tiny so tests can inject a local object.
        payload = jsonlib.dumps(json).encode("utf-8")
        request = Request(url, data=payload, headers={"Content-Type": "application/json"},
                          method="POST")
        with urlopen(request, timeout=60) as response:
            return jsonlib.loads(response.read().decode("utf-8"))


class OllamaEmbedder:
    """Call Ollama's batch API. dim is zero until the first nonempty batch."""

    def __init__(self, model: str, base_url: str = "http://localhost:11434", http=None):
        if not model.strip():
            raise ValueError("model must be nonempty")
        self.model_id = model
        self.dim = 0
        self.base_url = base_url.rstrip("/")
        self.http = http if http is not None else _UrllibHTTP()

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        response = self.http.post(self.base_url + "/api/embed",
                                  json={"model": self.model_id, "input": texts})
        embeddings = response.get("embeddings")
        if not isinstance(embeddings, list) or len(embeddings) != len(texts):
            raise ValueError("Ollama returned an invalid embedding count")
        vectors = [_vector(vector) for vector in embeddings]
        dim = self.dim or len(vectors[0])
        if any(len(vector) != dim for vector in vectors):
            raise ValueError("Ollama returned inconsistent vector dimensions")
        self.dim = dim
        return vectors

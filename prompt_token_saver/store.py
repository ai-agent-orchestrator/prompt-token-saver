"""Vector stores with one embedding model per index."""

from pathlib import Path
from typing import Protocol

from .embed import _vector, cosine
from .types import Chunk


class VectorStore(Protocol):
    model_id: str | None

    def add(self, chunks: list[Chunk], vectors: list[list[float]], *,
            model_id: str | None = None) -> None: ...

    def search(self, vector: list[float], k: int) -> list[tuple[str, float]]: ...

    def get(self, chunk_id: str) -> Chunk: ...


def _model(current: str | None, incoming: str | None) -> str:
    selected = incoming if incoming is not None else current
    if not isinstance(selected, str) or not selected.strip():
        raise ValueError("Specify model_id when creating the store or adding vectors")
    if current is not None and selected != current:
        raise ValueError("Embedding model_id does not match the index")
    return selected


def _batch(chunks, vectors, dim):
    if len(chunks) != len(vectors):
        raise ValueError("Chunk and vector counts must match")
    if len({chunk.id for chunk in chunks}) != len(chunks):
        raise ValueError("Chunk IDs must be unique within a batch")
    vectors = [_vector(vector) for vector in vectors]
    expected = dim or (len(vectors[0]) if vectors else None)
    if any(len(vector) != expected for vector in vectors):
        raise ValueError("Vector dimensions must match the index")
    return vectors, expected


def _check_k(k):
    if isinstance(k, bool) or not isinstance(k, int) or k < 0:
        raise ValueError("k must be a nonnegative integer")


class MemoryStore:
    """Exact cosine search. Repeated IDs replace the existing chunk and vector.

    Untagged vectors use the store's model_id; pass model_id to add when the
    caller needs to verify the producing embedder explicitly.
    """

    def __init__(self, model_id: str | None = None):
        self._model_id = _model(None, model_id) if model_id is not None else None
        self._dim = None
        self._items = {}

    @property
    def model_id(self) -> str | None:
        return self._model_id

    def add(self, chunks: list[Chunk], vectors: list[list[float]], *,
            model_id: str | None = None) -> None:
        selected = _model(self.model_id, model_id)
        vectors, dim = _batch(chunks, vectors, self._dim)
        self._items.update({chunk.id: (chunk, vector)
                            for chunk, vector in zip(chunks, vectors)})
        self._model_id, self._dim = selected, dim

    def search(self, vector: list[float], k: int) -> list[tuple[str, float]]:
        _check_k(k)
        vector = _vector(vector)
        if self._dim is not None and len(vector) != self._dim:
            raise ValueError("Vector dimensions must match the index")
        scores = [(key, cosine(vector, stored))
                  for key, (_, stored) in self._items.items()]
        return sorted(scores, key=lambda item: (-item[1], item[0]))[:k]

    def get(self, chunk_id: str) -> Chunk:
        return self._items[chunk_id][0]


class ChromaStore:
    """Persistent Chroma storage using cosine distance and collection metadata."""

    def __init__(self, path: str | Path, collection: str, model_id: str | None = None):
        try:
            import chromadb
        except ImportError as exc:
            raise ImportError("Install optional storage: pip install prompt-token-saver[chroma]") from exc
        self._client = chromadb.PersistentClient(path=str(Path(path)))
        self._collection = self._client.get_or_create_collection(
            name=collection, metadata={"hnsw:space": "cosine"})
        metadata = self._collection.metadata or {}
        stored = metadata.get("model_id")
        if stored is None and self._collection.count():
            raise ValueError("Existing index has no embedding model_id")
        self._model_id = _model(stored, model_id) if model_id is not None else stored
        self._dim = metadata.get("embedding_dim")
        if metadata.get("hnsw:space") != "cosine":
            raise ValueError("Collection must use cosine distance")
        if self.model_id is not None and stored is None:
            self._collection.modify(metadata={**metadata, "model_id": self.model_id})

    @property
    def model_id(self) -> str | None:
        return self._model_id

    def add(self, chunks: list[Chunk], vectors: list[list[float]], *,
            model_id: str | None = None) -> None:
        selected = _model(self.model_id, model_id)
        vectors, dim = _batch(chunks, vectors, self._dim)
        if chunks:
            self._collection.upsert(
                ids=[chunk.id for chunk in chunks], embeddings=vectors,
                documents=[chunk.text for chunk in chunks],
                metadatas=[{"doc_id": chunk.doc_id, "start": chunk.start, "end": chunk.end}
                           for chunk in chunks])
        metadata = {**(self._collection.metadata or {}), "model_id": selected}
        if dim is not None:
            metadata["embedding_dim"] = dim
        self._collection.modify(metadata=metadata)
        self._model_id, self._dim = selected, dim

    def search(self, vector: list[float], k: int) -> list[tuple[str, float]]:
        _check_k(k)
        vector = _vector(vector)
        if self._dim is not None and len(vector) != self._dim:
            raise ValueError("Vector dimensions must match the index")
        count = self._collection.count()
        if not k or not count:
            return []
        result = self._collection.query(query_embeddings=[vector], n_results=min(k, count),
                                        include=["distances"])
        return sorted(zip(result["ids"][0], [1.0 - d for d in result["distances"][0]]),
                      key=lambda item: (-item[1], item[0]))

    def get(self, chunk_id: str) -> Chunk:
        result = self._collection.get(ids=[chunk_id], include=["documents", "metadatas"])
        if not result["ids"]:
            raise KeyError(chunk_id)
        metadata = result["metadatas"][0]
        return Chunk(chunk_id, metadata["doc_id"], result["documents"][0],
                     metadata["start"], metadata["end"])

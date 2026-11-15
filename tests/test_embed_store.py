import builtins
import math

import pytest

from prompt_token_saver.embed import HashEmbedder, OllamaEmbedder, cosine
from prompt_token_saver.store import ChromaStore, MemoryStore
from prompt_token_saver.types import Chunk


def chunk(identifier, text="Synthetic text"):
    return Chunk(identifier, "doc", text, 0, len(text))


def test_hash_determinism_normalization_and_similarity():
    texts = ["orchard apple fruit harvest", "apple fruit orchard trees",
             "rocket launch galaxy orbit", "", "!? "]
    embedder = HashEmbedder()
    vectors = embedder.embed(texts)
    assert vectors == HashEmbedder().embed(texts)
    assert embedder.dim == 256
    assert embedder.model_id != HashEmbedder(128).model_id
    assert all(len(vector) == 256 for vector in vectors)
    for vector in vectors[:3]:
        assert math.sqrt(sum(x * x for x in vector)) == pytest.approx(1)
    assert cosine(vectors[0], vectors[1]) > cosine(vectors[0], vectors[2])
    assert vectors[3:] == [[0.0] * 256] * 2
    assert embedder.embed([]) == []
    assert embedder.embed(["APPLE"])[0] == embedder.embed(["apple"])[0]


@pytest.mark.parametrize("dim", [0, -1, 1.5, True])
def test_hash_invalid_dim(dim):
    with pytest.raises(ValueError):
        HashEmbedder(dim)


def test_cosine_boundaries():
    assert cosine([1, 0], [2, 0]) == pytest.approx(1)
    assert cosine([1, 0], [-2, 0]) == pytest.approx(-1)
    assert cosine([1, 0], [0, 2]) == 0
    assert cosine([0, 0], [1, 2]) == 0
    assert cosine([1e308, 1e308], [1e308, 1e308]) == pytest.approx(1)


@pytest.mark.parametrize("a,b", [([], []), ([1], [1, 2]),
                                     ([float("nan")], [1]), ([1], [float("inf")])])
def test_cosine_invalid_vectors(a, b):
    with pytest.raises(ValueError):
        cosine(a, b)


class FakeHTTP:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def post(self, url, json):
        self.calls.append((url, json))
        return self.response


def test_ollama_request_and_dimension():
    http = FakeHTTP({"embeddings": [[1, 0], [0, 1]]})
    embedder = OllamaEmbedder("synthetic-model", "http://localhost:11434/", http)
    assert embedder.dim == 0
    assert embedder.embed([]) == []
    assert http.calls == []
    assert embedder.embed(["first", "second"]) == [[1.0, 0.0], [0.0, 1.0]]
    assert http.calls == [("http://localhost:11434/api/embed",
                           {"model": "synthetic-model", "input": ["first", "second"]})]
    assert embedder.dim == 2
    assert embedder.model_id == "synthetic-model"
    http.response = {"embeddings": [[1, 2, 3]]}
    with pytest.raises(ValueError, match="dimensions"):
        embedder.embed(["third"])
    assert embedder.dim == 2


@pytest.mark.parametrize("response", [{}, {"embeddings": []},
    {"embeddings": [[], []]}, {"embeddings": [[1], [1, 2]]},
    {"embeddings": [[1], [float("nan")]]}])
def test_ollama_invalid_response(response):
    embedder = OllamaEmbedder("test", http=FakeHTTP(response))
    with pytest.raises(ValueError):
        embedder.embed(["a", "b"])
    assert embedder.dim == 0


def test_ollama_requires_model():
    with pytest.raises(ValueError):
        OllamaEmbedder(" ", http=FakeHTTP({}))


def test_memory_real_hash_embeddings_search_and_copy():
    embedder = HashEmbedder()
    chunks = [chunk("fruit", "orchard apple fruit harvest"),
              chunk("space", "rocket launch galaxy orbit")]
    vectors = embedder.embed([c.text for c in chunks])
    store = MemoryStore(embedder.model_id)
    store.add(chunks, vectors)
    assert store.search(embedder.embed([chunks[0].text])[0], 10)[0][0] == "fruit"
    assert store.get("space") == chunks[1]
    vectors[0][:] = [0] * embedder.dim
    assert store.search(embedder.embed([chunks[0].text])[0], 1)[0][1] == pytest.approx(1)
    assert store.search([0] * embedder.dim, 0) == []
    with pytest.raises(KeyError):
        store.get("missing")


def test_memory_ties_replacement_and_empty():
    store = MemoryStore("test")
    assert store.search([1, 0], 1) == []
    store.add([chunk("b"), chunk("a")], [[1, 0], [1, 0]])
    assert store.search([1, 0], 2) == [("a", 1), ("b", 1)]
    replacement = chunk("b", "New synthetic text")
    store.add([replacement], [[0, 1]])
    assert store.get("b") == replacement
    assert store.search([1, 0], 2) == [("a", 1), ("b", 0)]


def test_memory_model_binding_and_mixing_error():
    store = MemoryStore()
    with pytest.raises(ValueError, match="model_id"):
        store.add([chunk("a")], [[1, 0]])
    store.add([chunk("a")], [[1, 0]], model_id="first")
    assert store.model_id == "first"
    with pytest.raises(ValueError, match="model_id"):
        store.add([chunk("b")], [[1, 0]], model_id="second")
    assert store.search([1, 0], 5) == [("a", 1)]
    with pytest.raises(AttributeError):
        store.model_id = "second"


@pytest.mark.parametrize("chunks,vectors", [([chunk("x")], []),
    ([chunk("x"), chunk("x")], [[1, 0], [1, 0]]),
    ([chunk("x")], [[1]]), ([chunk("x")], [[]]),
    ([chunk("x")], [[float("inf"), 0]])])
def test_memory_rejects_invalid_batch_atomically(chunks, vectors):
    store = MemoryStore("test")
    store.add([chunk("original")], [[1, 0]])
    with pytest.raises(ValueError):
        store.add(chunks, vectors)
    assert store.search([1, 0], 10) == [("original", 1)]


@pytest.mark.parametrize("k", [-1, 1.5, True])
def test_memory_invalid_search_k(k):
    with pytest.raises(ValueError):
        MemoryStore("test").search([1], k)


def test_memory_invalid_search_dimension():
    store = MemoryStore("test")
    store.add([chunk("x")], [[1, 0]])
    with pytest.raises(ValueError, match="dimensions"):
        store.search([1], 1)


def test_missing_chroma_has_install_guidance(monkeypatch, tmp_path):
    original_import = builtins.__import__

    def without_chroma(name, *args, **kwargs):
        if name == "chromadb":
            raise ModuleNotFoundError("synthetic missing optional dependency")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_chroma)
    with pytest.raises(ImportError, match=r"pip install prompt-token-saver\[chroma\]"):
        ChromaStore(tmp_path, "synthetic")

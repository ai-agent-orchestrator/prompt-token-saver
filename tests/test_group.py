import pytest

from prompt_token_saver.embed import HashEmbedder
from prompt_token_saver.group import group_chunks
from prompt_token_saver.types import Chunk


def chunks(texts):
    return [Chunk(f"doc:{i}", "doc", text, i * 100, i * 100 + len(text))
            for i, text in enumerate(texts)]


def test_synthetic_topics_and_threshold_boundaries():
    source = chunks(["apple orchard fruit harvest", "rocket galaxy orbit launch",
                     "apple orchard fruit trees", "rocket galaxy orbit mission"])
    vectors = HashEmbedder().embed([c.text for c in source])
    groups = group_chunks(source, vectors)
    assert [g.chunk_ids for g in groups] == [["doc:0", "doc:2"], ["doc:1", "doc:3"]]
    assert group_chunks(source, vectors) == groups
    assert len({g.id for g in groups}) == 2
    assert [g.chunk_ids for g in group_chunks(source, vectors, threshold=1)] == [
        [c.id] for c in source]
    assert [g.chunk_ids for g in group_chunks(source, vectors, threshold=0)] == [
        [c.id for c in source]]


def test_average_link_uses_all_pairs():
    source = chunks(["a", "b", "c"])
    # A-B and B-C pass, but the average of A-C and B-C does not.
    vectors = [[1, 0], [0.8, 0.6], [0.28, 0.96]]
    assert [g.chunk_ids for g in group_chunks(source, vectors, threshold=0.7)] == [
        ["doc:0", "doc:1"], ["doc:2"]]


def test_empty_singleton_min_size_and_zero_vectors():
    assert group_chunks([], []) == []
    source = chunks(["a", "b", "c"])
    vectors = [[1, 0], [1, 0], [0, 1]]
    assert [g.chunk_ids for g in group_chunks(source, vectors, min_size=2)] == [
        ["doc:0", "doc:1"]]
    assert group_chunks(source, vectors, min_size=4) == []
    assert len(group_chunks(source[:1], vectors[:1])) == 1
    assert len(group_chunks(source, [[0, 0]] * 3)) == 3
    assert len(group_chunks(source, [[0, 0]] * 3, threshold=0)) == 1


def test_deterministic_ties_and_content_based_group_ids():
    source = chunks(["a", "b", "c"])
    groups = group_chunks(source, [[1, 0], [0, 1], [0, -1]], threshold=0)
    assert [g.chunk_ids for g in groups] == [["doc:0", "doc:1"], ["doc:2"]]
    singleton = group_chunks(source[2:], [[0, -1]])[0]
    assert singleton.id == groups[1].id


@pytest.mark.parametrize("threshold", [-1.1, 1.1, float("nan"), float("inf")])
def test_invalid_threshold(threshold):
    with pytest.raises(ValueError):
        group_chunks([], [], threshold=threshold)


@pytest.mark.parametrize("min_size", [0, -1, 1.5, True])
def test_invalid_min_size(min_size):
    with pytest.raises(ValueError):
        group_chunks([], [], min_size=min_size)


@pytest.mark.parametrize("source,vectors", [(chunks(["a"]), []),
    (chunks(["a", "b"]), [[1], [1, 0]]), (chunks(["a"]), [[]]),
    (chunks(["a"]), [[float("nan")]]),
    ([Chunk("same", "doc", "x", 0, 1)] * 2, [[1], [1]])])
def test_invalid_inputs(source, vectors):
    with pytest.raises(ValueError):
        group_chunks(source, vectors)

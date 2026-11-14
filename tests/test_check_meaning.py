import pytest

from prompt_token_saver.check_meaning import GapRule, check_meaning
from prompt_token_saver.embed import HashEmbedder, cosine
from prompt_token_saver.store import MemoryStore
from prompt_token_saver.types import Chunk, Summary


FRUIT = "The orchard grows apples and pears."
SPACE = "The rocket travels through distant galaxies."
INVENTED = "Penguins play violins beneath the ocean."


def setup_sources(texts):
    embedder = HashEmbedder()
    chunks = [Chunk(str(i), "synthetic", text, 0, len(text))
              for i, text in enumerate(texts)]
    store = MemoryStore(embedder.model_id)
    store.add(chunks, embedder.embed(texts))
    return chunks, store, embedder


def run(sentences, texts=(FRUIT, SPACE), rule=None):
    chunks, store, embedder = setup_sources(list(texts))
    summary = Summary("group", " ".join(sentences), sentences, "extractive")
    result = check_meaning(summary, chunks, store, embedder,
                           rule or GapRule.default_for(embedder.model_id))
    return result


def test_verbatim_summary_passes_with_evidence_and_metadata():
    result = run([FRUIT, SPACE])
    assert result.name == "meaning"
    assert result.passed
    assert result.score == 1
    assert result.details["unsupported_sentences"] == []
    assert result.details["missing_core_candidates"] == []
    for index, record in enumerate(result.details["sentences"]):
        assert record["index"] == index
        assert record["sentence"] == [FRUIT, SPACE][index]
        assert record["chunk_id"] == str(index)
        assert record["top2_chunk_id"] == str(1 - index)
        assert record["top1"] == pytest.approx(1)
        assert record["top2"] < record["top1"]
        assert record["supported"]
    assert result.details["rule"] == {
        "tau_abs": 0.8, "tau_gap": 0.1,
        "version": "hash-unigram-char3-v1-uncalibrated", "coverage_min": 0.5}


def test_invented_sentence_is_identified():
    result = run([FRUIT, INVENTED])
    assert not result.passed
    assert result.score == 0.5
    assert result.details["unsupported_sentences"] == [INVENTED]
    assert not result.details["sentences"][1]["supported"]


def test_one_source_ignores_gap_but_enforces_absolute_threshold():
    rule = GapRule(0.8, 2, "single-source")
    result = run([FRUIT, INVENTED], [FRUIT], rule)
    assert result.details["unsupported_sentences"] == [INVENTED]
    assert result.details["sentences"][0]["supported"]
    assert result.details["sentences"][0]["top2"] is None
    assert result.details["rule"]["version"] == "single-source"


def test_tied_sources_fail_positive_gap_even_for_verbatim_sentence():
    result = run([FRUIT], [FRUIT, FRUIT], GapRule(0.8, 0.1, "ties"))
    assert not result.passed
    assert result.details["sentences"][0]["top1"] == pytest.approx(1)
    assert result.details["sentences"][0]["top2"] == pytest.approx(1)


def test_thresholds_are_inclusive_and_both_conditions_are_required():
    embedder = HashEmbedder()
    first, second = embedder.embed([FRUIT, SPACE])
    top1, top2 = cosine(first, first), cosine(first, second)
    assert run([FRUIT], rule=GapRule(top1, top1 - top2, "boundary")).passed
    assert not run([FRUIT], rule=GapRule(top1, top1 - top2 + 0.001, "gap")).passed
    assert not run([INVENTED], rule=GapRule(1, 0, "absolute")).passed
    assert run([FRUIT], [FRUIT, FRUIT], GapRule(top1, 0, "zero-gap")).passed


def test_missing_core_is_display_only_and_coverage_boundary_is_inclusive():
    result = run([FRUIT], rule=GapRule(0.8, 0.1, "coverage", coverage_min=0.9))
    assert result.passed
    assert [item["chunk_id"] for item in result.details["missing_core_candidates"]] == ["1"]
    assert result.details["coverage"][0]["max_cosine"] == pytest.approx(1)
    vector = HashEmbedder().embed([FRUIT])[0]
    boundary = cosine(vector, vector)
    assert not run([FRUIT], [FRUIT], GapRule(0, 0, "boundary", boundary)).details[
        "missing_core_candidates"]


def test_coverage_uses_best_of_all_summary_sentences():
    result = run([SPACE, FRUIT])
    assert all(item["max_cosine"] == pytest.approx(1) for item in result.details["coverage"])


def test_empty_summary_passes_and_marks_all_sources_missing():
    result = run([])
    assert result.passed and result.score == 1
    assert result.details["sentences"] == []
    assert len(result.details["missing_core_candidates"]) == 2
    assert all(item["max_cosine"] is None for item in result.details["coverage"])


def test_no_sources_cannot_support_sentences():
    result = run([FRUIT], [])
    assert not result.passed and result.score == 0
    record = result.details["sentences"][0]
    assert record["top1"] is record["top2"] is record["chunk_id"] is None
    assert result.details["coverage"] == []
    assert run([], []).passed


def test_search_is_scoped_to_sources_in_shared_store_without_mutation():
    chunks, store, embedder = setup_sources([FRUIT, SPACE])
    outsiders = [Chunk(f"outside:{i}", "other", INVENTED, 0, len(INVENTED))
                 for i in range(5)]
    store.add(outsiders, embedder.embed([INVENTED] * len(outsiders)))
    vector = embedder.embed([INVENTED])[0]
    before = store.search(vector, 20)
    summary = Summary("group", INVENTED, [INVENTED], "model")
    result = check_meaning(summary, chunks, store, embedder,
                           GapRule.default_for(embedder.model_id))
    assert not result.passed
    assert result.details["sentences"][0]["chunk_id"] in {"0", "1"}
    assert result.details["sentences"][0]["top2"] is not None
    assert store.search(vector, 20) == before


def test_model_and_source_index_must_match():
    chunks, store, embedder = setup_sources([FRUIT])
    summary = Summary("group", FRUIT, [FRUIT], "model")
    rule = GapRule.default_for(embedder.model_id)
    with pytest.raises(ValueError, match="model_id"):
        check_meaning(summary, chunks, store, HashEmbedder(128), rule)
    with pytest.raises(ValueError, match="unique"):
        check_meaning(summary, chunks * 2, store, embedder, rule)
    changed = Chunk("0", "synthetic", SPACE, 0, len(SPACE))
    with pytest.raises(ValueError, match="indexed chunk"):
        check_meaning(summary, [changed], store, embedder, rule)
    with pytest.raises(KeyError):
        check_meaning(summary, [Chunk("absent", "doc", FRUIT, 0, len(FRUIT))],
                      store, embedder, rule)


@pytest.mark.parametrize("model_id", ["other-model", "hash-unigram-char3-v1:0",
                                     "hash-unigram-char3-v1:bad"])
def test_unknown_models_have_no_implicit_thresholds(model_id):
    with pytest.raises(ValueError, match="calibrated"):
        GapRule.default_for(model_id)


@pytest.mark.parametrize("kwargs", [
    {"tau_abs": float("nan")}, {"tau_abs": 1.1}, {"tau_abs": -1.1},
    {"tau_gap": -0.1}, {"tau_gap": 2.1}, {"tau_gap": float("inf")},
    {"coverage_min": -1.1}, {"coverage_min": float("nan")}, {"version": " "},
])
def test_invalid_rule(kwargs):
    values = {"tau_abs": 0.8, "tau_gap": 0.1, "version": "test"}
    values.update(kwargs)
    with pytest.raises(ValueError):
        GapRule(**values)

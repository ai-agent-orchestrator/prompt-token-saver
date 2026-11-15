import builtins
import math

import pytest

from prompt_token_saver.surprise import Anchor, IdfScorer, LogprobScorer, extract_anchors


def test_idf_uses_document_frequency_and_unseen_smoothing():
    scorer = IdfScorer(["common common rare", "common"])
    scores = {word: value for word, _, _, value in scorer.score("common rare unseen")}
    assert scores["common"] == pytest.approx(-math.log(3 / 4))
    assert scores["rare"] == pytest.approx(-math.log(2 / 4))
    assert scores["unseen"] == pytest.approx(-math.log(1 / 4))
    assert scores["common"] < scores["rare"] < scores["unseen"]


def test_numeric_and_name_bonuses_rank_above_common_words():
    scorer = IdfScorer(["the report lists totals"] * 3)
    scored = scorer.score("the report lists Mira 42 12% $30")
    scores = {word: value for word, _, _, value in scored}
    base = -math.log(1 / 5)
    assert scores["Mira"] == pytest.approx(base + 1)
    assert scores["42"] == pytest.approx(base + 2)
    assert scores["12%"] == pytest.approx(base + 3)
    assert scores["$30"] == pytest.approx(base + 3)
    assert scores["report"] < scores["Mira"] < scores["42"]


def test_sentence_initials_do_not_receive_capital_bonus():
    scores = [value for _, _, _, value in IdfScorer([]).score(
        '"Alpha meets Bravo. Charlie meets Delta! Echo? Foxtrot')]
    base = math.log(2)
    assert scores == pytest.approx([base, base, base + 1, base, base, base + 1, base, base])


def test_scoring_preserves_source_offsets_and_normalizes_corpus_words():
    text = "  서울시는 매출 1,200.00 및 12 %를 보고했다."
    scorer = IdfScorer(["서울시 매출 1200 12%"])
    scored = scorer.score(text)
    assert all(text[start:end] == word for word, start, end, _ in scored)
    scores = {word: value for word, _, _, value in scored}
    assert scores["서울시는"] == pytest.approx(-math.log(2 / 3))
    assert scores["1,200.00"] == pytest.approx(-math.log(2 / 3) + 2)
    assert scores["12 %"] == pytest.approx(-math.log(2 / 3) + 3)


def test_empty_scorer_and_input():
    assert IdfScorer([]).score("!? \n") == []
    assert IdfScorer([]).score("word")[0][3] == pytest.approx(math.log(2))


def test_anchor_ratio_rounds_up_and_forces_numbers_in_source_order():
    scored = [("rare", 0, 4, 10.0), ("Mira", 5, 9, 9.0),
              ("42", 10, 12, 0.0), ("common", 13, 19, 1.0)]
    anchors = extract_anchors(scored, top_ratio=0.26)
    assert [anchor.text for anchor in anchors] == ["rare", "Mira", "42"]
    assert [anchor.kind for anchor in anchors] == ["term", "name", "number"]
    assert anchors[-1].context == ("mira", "common")
    assert anchors[-1].start == 10
    assert anchors[-1].end == 12
    assert anchors[-1].surprisal == 0


def test_anchor_zero_full_ratio_and_optional_forced_kinds():
    scored = IdfScorer([]).score("word Mira 42")
    assert [a.text for a in extract_anchors(scored, 0)] == ["42"]
    assert extract_anchors(scored, 0, always=()) == []
    assert [a.text for a in extract_anchors(scored, 0, always=("name",))] == ["Mira"]
    assert len(extract_anchors(scored, 1)) == len(scored)
    assert extract_anchors([]) == []


def test_anchor_ties_and_repeated_occurrences_are_deterministic():
    scored = [("same", 0, 4, 1.0), ("same", 5, 9, 1.0)]
    assert extract_anchors(scored, 0.5, ())[0].start == 0
    assert [a.start for a in extract_anchors(scored, 1)] == [0, 5]


def test_anchor_normalization_and_default_context():
    anchors = extract_anchors(IdfScorer([]).score("서울시는 Mira 1,200.00 12 % $03.00"), 1)
    assert [a.norm for a in anchors] == ["서울시", "mira", "1200", "12%", "$3"]
    assert Anchor("42", "42", "number", 0, 2, 2).context == ("", "")


@pytest.mark.parametrize("ratio", [-0.1, 1.1, float("nan"), float("inf")])
def test_invalid_anchor_ratio(ratio):
    with pytest.raises(ValueError, match="top_ratio"):
        extract_anchors([], ratio)


def test_invalid_forced_kind():
    with pytest.raises(ValueError, match="always"):
        extract_anchors([], always=("unknown",))


def test_logprob_missing_transformers_has_install_guidance(monkeypatch):
    original_import = builtins.__import__

    def without_optional_models(name, *args, **kwargs):
        if name == "transformers":
            raise ModuleNotFoundError("transformers")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_optional_models)
    with pytest.raises(RuntimeError, match=r"pip install 'prompt-token-saver\[logprob\]'"):
        LogprobScorer("synthetic-local-model")

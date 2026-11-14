import pytest

from prompt_token_saver.check_anchor import check_anchors
from prompt_token_saver.surprise import Anchor, IdfScorer, extract_anchors
from prompt_token_saver.types import Summary


def anchors(text):
    return extract_anchors(IdfScorer([]).score(text), top_ratio=1)


def test_retained_anchors_and_summary_record():
    source = "서울시는 매출 1,200.00 기록"
    summary = Summary("g", "서울시 매출 1200 기록", [], "extractive")
    result = check_anchors(summary, anchors(source))
    assert result.name == "anchor"
    assert result.passed
    assert result.score == 1
    assert result.details["missing"] == result.details["changed"] == []


def test_missing_number_fails_and_identifies_original_span():
    source = "매출 42 기록"
    result = check_anchors("매출 기록", anchors(source))
    assert not result.passed
    missing = result.details["missing_numbers"]
    assert [item["text"] for item in missing] == ["42"]
    assert source[missing[0]["start"]:missing[0]["end"]] == "42"
    assert result.details["changed"] == []
    assert result.score == pytest.approx(2 / 3)


@pytest.mark.parametrize("summary", ["매출 43 기록", "매출 43", "43 기록"])
def test_changed_number_has_contextual_evidence(summary):
    result = check_anchors(summary, anchors("매출 42 기록"))
    assert not result.passed
    changed = result.details["changed"]
    assert changed[0]["anchor"]["text"] == "42"
    replacement = changed[0]["replacements"][0]
    assert replacement["norm"] == "43"
    assert summary[replacement["start"]:replacement["end"]] == "43"
    assert result.details["missing_numbers"][0]["text"] == "42"


def test_unrelated_number_is_missing_without_changed_classification():
    result = check_anchors("인구 99 증가", anchors("매출 42 기록"))
    assert not result.passed
    assert result.details["changed"] == []


def test_number_elsewhere_does_not_hide_contextual_substitution():
    result = check_anchors("매출 43. 인구 42.", anchors("매출 42"))
    assert not result.passed
    assert result.details["changed"][0]["replacements"][0]["text"] == "43"


def test_retained_contextual_number_ignores_other_context_candidates():
    result = check_anchors("매출 42 기록. 비용 99 기록.", anchors("매출 42 기록"))
    assert result.passed
    assert result.details["changed"] == []


def test_changed_number_requires_source_context():
    anchor = Anchor("42", "42", "number", 0, 2, 2)
    result = check_anchors("매출 43", [anchor])
    assert not result.passed
    assert result.details["changed"] == []


@pytest.mark.parametrize("source, summary", [
    ("서울시는", "서울시"), ("서울시", "서울시는"),
    ("Mira", "mira"), ("12 %", "12.00%"),
    ("-1,200.50", "-1200.500"), ("4.1B", "4.10b"),
    ("$003.00", "$3"), ("매출 42 기록", "매출은 43 기록"),
])
def test_normalized_matching_or_changed_context(source, summary):
    result = check_anchors(summary, anchors(source))
    if "43" in summary:
        assert result.details["changed"]
    else:
        assert result.passed
        assert result.score == 1


@pytest.mark.parametrize("source, summary", [
    ("12", "112"), ("12%", "12"), ("$12", "€12"),
    ("Mira", "Miranda"), ("서울시", "서울시장"), ("4.1B", "41억"),
])
def test_no_substring_or_unit_conversion_matches(source, summary):
    result = check_anchors(summary, anchors(source))
    assert result.score == 0
    if source != "서울시":
        assert not result.passed


def test_missing_name_threshold_is_inclusive_and_configurable():
    source_anchors = anchors("Mira Nora Hana Juno Lena")
    result = check_anchors("Mira Nora Hana Juno", source_anchors)
    assert result.passed
    assert result.details["missing_name_ratio"] == 0.2
    assert result.details["missing_names"][0]["text"] == "Lena"
    assert not check_anchors("Mira Nora Hana", source_anchors).passed
    assert check_anchors("Mira Nora Hana", source_anchors, 0.4).passed
    assert not check_anchors("Mira Nora Hana Juno", source_anchors, 0).passed


def test_missing_terms_only_reduce_coverage():
    result = check_anchors("", anchors("ordinary terms"))
    assert result.passed
    assert result.score == 0
    assert result.details["missing_name_ratio"] == 0


def test_empty_anchors_pass_and_empty_summary_loses_numbers():
    assert check_anchors("", []).passed
    assert check_anchors("arbitrary", []).score == 1
    assert not check_anchors("", anchors("42")).passed


def test_repeated_anchors_are_presence_checks():
    result = check_anchors("42", anchors("42 42"))
    assert result.passed
    assert result.score == 1


@pytest.mark.parametrize("ratio", [-0.1, 1.1, float("nan"), float("inf")])
def test_invalid_missing_name_ratio(ratio):
    with pytest.raises(ValueError, match="max_missing_name_ratio"):
        check_anchors("", [], ratio)

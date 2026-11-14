from dataclasses import FrozenInstanceError

import pytest

from prompt_token_saver.text import chunk_text, normalize_number, split_sentences, strip_josa, tokens
from prompt_token_saver.types import CheckResult, Group, ItemResult, Summary


@pytest.mark.parametrize("text, expected", [
    ("안녕하세요. Hello! 잘 지내요? 네。", ["안녕하세요.", "Hello!", "잘 지내요?", "네。"]),
    ("값은 3.5 입니다. Next.", ["값은 3.5 입니다.", "Next."]),
    ("Use e.g. U.S. data. Dr. Kim agrees.", ["Use e.g. U.S. data.", "Dr. Kim agrees."]),
    ("첫 문단\n \n둘째 문단\r\n\r\n끝", ["첫 문단", "둘째 문단", "끝"]),
    ('  "Hello!"\n다음입니다.  ', ['"Hello!"', "다음입니다."]),
    ("한 줄\n이어서", ["한 줄\n이어서"]),
    ("", []), (" \n\t", []),
])
def test_split_sentences(text, expected):
    spans = split_sentences(text)
    assert [sentence for sentence, _, _ in spans] == expected
    assert all(text[start:end] == sentence for sentence, start, end in spans)


@pytest.mark.parametrize("suffix", ["은", "는", "이", "가", "을", "를", "의", "에", "에서", "으로", "로", "와", "과", "도", "만"])
def test_strip_josa(suffix):
    assert strip_josa("사람" + suffix) == "사람"


@pytest.mark.parametrize("word", ["나는", "집이", "집에서", "집으로", "가", "", "data", "abc는"])
def test_strip_josa_short_or_non_hangul(word):
    assert strip_josa(word) == word


def test_tokens():
    assert tokens("사람은 SEOUL에서 abc123, 자료를! 42") == ["사람", "seoul", "에서", "abc", "123", "자료", "42"]
    assert tokens("!? ") == []


@pytest.mark.parametrize("value, expected", [
    ("12%", "12%"), ("12 %", "12%"), ("4.1B", "4.1b"),
    ("41억", "41억"), ("4,100,000", "4100000"), ("-1,200.50", "-1200.5"),
    ("+0012.00", "12"), (" 0.00 % ", "0%"), (".50", "0.5"),
    ("N/A", "n/a"), ("", ""),
])
def test_normalize_number(value, expected):
    assert normalize_number(value) == expected


def test_chunk_text_offsets_and_limits():
    text = "  첫 문장.\n두 번째!  Third.\n\n마지막입니다.  "
    chunks = chunk_text("doc", text, max_chars=15)
    assert len(chunks) > 1
    assert all(chunk.text == text[chunk.start:chunk.end] for chunk in chunks)
    assert all(len(chunk.text) <= 15 for chunk in chunks)
    assert [chunk.id for chunk in chunks] == [f"doc:{i}" for i in range(len(chunks))]
    assert all(chunk.doc_id == "doc" for chunk in chunks)
    assert [sentence for chunk in chunks for sentence, _, _ in split_sentences(chunk.text)] == [
        sentence for sentence, _, _ in split_sentences(text)
    ]


def test_chunk_preserves_whitespace_and_whole_long_sentence():
    assert chunk_text("d", " A.\n\nB. ", 6)[0].text == "A.\n\nB."
    assert chunk_text("d", "long sentence!", 3)[0].text == "long sentence!"
    assert chunk_text("d", "A. B.", 2)[0].text == "A."
    assert chunk_text("d", " \n") == []


@pytest.mark.parametrize("limit", [0, -1])
def test_chunk_rejects_invalid_limit(limit):
    with pytest.raises(ValueError):
        chunk_text("d", "text", limit)


def test_shared_records():
    chunk = chunk_text("d", "Source.")[0]
    group = Group("g", [chunk.id])
    summary = Summary(group.id, "Source.", ["Source."], "extractive")
    check = CheckResult("meaning", True, 1.0, {"reason": "same"})
    item = ItemResult(group.id, group.chunk_ids, summary, [check], "pass", summary.text)
    assert item.checks[0].passed
    assert item.source_chunk_ids == [chunk.id]
    with pytest.raises(FrozenInstanceError):
        chunk.text = "changed"

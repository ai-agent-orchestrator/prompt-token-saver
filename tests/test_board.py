"""Offline board tests using reports from the real pipeline and checkers."""

from dataclasses import asdict
from html.parser import HTMLParser
import json
import re

import pytest

from prompt_token_saver.board import render, wilson_interval
from prompt_token_saver.check_meaning import GapRule
from prompt_token_saver.embed import HashEmbedder
from prompt_token_saver.pipeline import run
from prompt_token_saver.store import MemoryStore
from prompt_token_saver.summarize import TruncatingFakeSummarizer
from prompt_token_saver.surprise import IdfScorer, extract_anchors
from prompt_token_saver.text import chunk_text, split_sentences
from prompt_token_saver.types import Summary


class ChangedSummary:
    def summarize(self, chunks, max_sentences):
        text = "the synthetic station recorded 43 samples. dragons teleport."
        return Summary("candidate", text,
                       [sentence for sentence, _, _ in split_sentences(text)], "model")


class Page(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.tags = []
        self.marks = []
        self.current_mark = None
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.tags.append((tag, attrs))
        if tag == "mark":
            self.current_mark = (attrs, [])

    def handle_data(self, data):
        if self.current_mark:
            self.current_mark[1].append(data)

    def handle_endtag(self, tag):
        if tag == "mark" and self.current_mark:
            attrs, parts = self.current_mark
            self.marks.append((attrs, ''.join(parts)))
            self.current_mark = None


def make_report(tmp_path, *, source="the synthetic station recorded 42 samples.",
                summarizer=None, empty=False):
    docs = {} if empty else {"synthetic": source}
    embedder = HashEmbedder()
    scorer = IdfScorer(list(docs.values()))
    report = run(docs, embedder=embedder, store=MemoryStore(), summarizer=summarizer,
                 scorer=scorer, meaning_rule=GapRule.default_for(embedder.model_id))
    data = asdict(report)
    chunks = {chunk.id: chunk for doc_id, text in docs.items()
              for chunk in chunk_text(doc_id, text)}
    for item in data["items"]:
        sources = [chunks[key] for key in item["source_chunk_ids"]]
        item["source_chunks"] = [asdict(chunk) for chunk in sources]
        item["anchors"] = [asdict(anchor) for anchor in extract_anchors(
            scorer.score("\n\n".join(chunk.text for chunk in sources)))]
    path = tmp_path / "report.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path, data


@pytest.mark.parametrize("passed,total,expected", [
    (0, 0, (0, 1)), (0, 10, (0, 0.2775327999)),
    (5, 10, (0.2365930905, 0.7634069095)),
    (10, 10, (0.7224672001, 1)), (50, 100, (0.4038315304, 0.5961684696)),
])
def test_wilson_known_values(passed, total, expected):
    assert wilson_interval(passed, total) == pytest.approx(expected, abs=1e-9)


@pytest.mark.parametrize("passed,total", [(-1, 10), (11, 10), (0, -1)])
def test_wilson_invalid_counts(passed, total):
    with pytest.raises(ValueError):
        wilson_interval(passed, total)


def test_self_contained_dark_board(tmp_path):
    path, data = make_report(tmp_path)
    output = tmp_path / "nested" / "board.html"
    render(path, output)
    html = output.read_text(encoding="utf-8")
    page = Page(html)
    for tag, attrs in page.tags:
        if tag == "script":
            assert "src" not in attrs
        if tag == "link":
            assert not attrs.get("href", "").startswith(("http:", "https:", "//"))
    assert all(color in html for color in (
        "#0e141b", "#131c27", "#24324a", "#5ba7db", "#4cc3a8", "#78d5ef", "#e6edf6", "#c58b92"))
    assert "Wilson 95% 구간 20.65%–100.00%" in html
    assert "통과율 100.0%" in html
    assert data["settings"]["threshold_version"] in html
    assert all(label in html for label in ("판정 맞음", "판정 틀림", "라벨 내보내기", "검사 A", "검사 B"))
    assert "localStorage.setItem" in html and "catch (_)" in html
    assert "new Blob" in html and "URL.revokeObjectURL" in html


def test_missing_changed_and_unsupported_marks(tmp_path):
    source = "the synthetic station recorded 42 samples."
    path, _ = make_report(tmp_path, source=source, summarizer=ChangedSummary())
    output = tmp_path / "board.html"
    render(path, output)
    page = Page(output.read_text(encoding="utf-8"))
    source_marks = [(attrs, text) for attrs, text in page.marks
                    if attrs["class"] != "unsupported"]
    assert any(attrs["class"] == "changed" and text == "42" for attrs, text in source_marks)
    assert any(attrs["class"] == "unsupported" and "dragons" in text for attrs, text in page.marks)
    for attrs, text in source_marks:
        assert source[int(attrs["data-start"]):int(attrs["data-end"])] == text


def test_repeated_unicode_anchors_use_original_offsets(tmp_path):
    source = "😀 synthetic robots record 42 samples and 42 samples."
    path, _ = make_report(tmp_path, source=source)
    output = tmp_path / "board.html"
    render(path, output)
    marks = Page(output.read_text(encoding="utf-8")).marks
    numbers = [(attrs, text) for attrs, text in marks if text == "42"]
    assert len(numbers) == 2
    assert len({attrs["data-start"] for attrs, _ in numbers}) == 2
    assert all(source[int(attrs["data-start"]):int(attrs["data-end"])] == text
               and attrs["class"] == "retained" for attrs, text in numbers)


def test_missing_anchor_has_red_underline_class(tmp_path):
    path, _ = make_report(tmp_path, summarizer=TruncatingFakeSummarizer())
    output = tmp_path / "board.html"
    render(path, output)
    assert any(attrs["class"] == "missing" and text == "42"
               for attrs, text in Page(output.read_text(encoding="utf-8")).marks)


def test_group_chunk_offsets_are_local_in_each_card_column(tmp_path):
    sentence = "synthetic robots record 42 samples. "
    path, data = make_report(tmp_path, source=sentence * 26)
    assert any(len(item["source_chunks"]) > 1 for item in data["items"])
    output = tmp_path / "board.html"
    render(path, output)
    html = output.read_text(encoding="utf-8")
    sources = re.findall(r'<pre class="source">(.*?)</pre>', html, re.S)
    chunks = [chunk for item in data["items"] for chunk in item["source_chunks"]]
    assert len(sources) == len(chunks)
    for fragment, chunk in zip(sources, chunks):
        for attrs, text in Page(fragment).marks:
            assert chunk["text"][int(attrs["data-start"]):int(attrs["data-end"])] == text


def test_untrusted_report_content_cannot_add_tags(tmp_path):
    attack = '</script><script>alert("synthetic")</script><img src=x onerror="bad"> &'
    path, data = make_report(tmp_path, source="synthetic " + attack + " 42 samples.")
    data["items"][0]["group_id"] = attack
    data["settings"]["threshold_version"] = attack
    path.write_text(json.dumps(data), encoding="utf-8")
    output = tmp_path / "board.html"
    render(path, output)
    html = output.read_text(encoding="utf-8")
    tags = Page(html).tags
    assert len([tag for tag, _ in tags if tag == "script"]) == 2
    assert not any(tag == "img" for tag, _ in tags)
    assert "&lt;script&gt;" in html
    payload = re.search(r'<script id="board-data" type="application/json">(.*?)</script>', html, re.S)[1]
    assert "<" not in payload
    assert json.loads(payload)["items"][0]["group_id"] == attack


def test_legacy_report_does_not_read_source_paths(tmp_path):
    path, data = make_report(tmp_path)
    del data["items"][0]["source_chunks"]
    del data["items"][0]["anchors"]
    data["items"][0]["source_chunk_ids"] = [str(tmp_path / "absent.txt")]
    path.write_text(json.dumps(data), encoding="utf-8")
    output = tmp_path / "board.html"
    render(path, output)
    assert "원문 청크가 없습니다" in output.read_text(encoding="utf-8")


def test_empty_board(tmp_path):
    path, _ = make_report(tmp_path, empty=True)
    output = tmp_path / "board.html"
    render(path, output)
    html = output.read_text(encoding="utf-8")
    assert "항목이 없습니다" in html
    assert "통과율 0.0%" in html
    assert "Wilson 95% 구간 0.00%–100.00%" in html


@pytest.mark.parametrize("content", ["invalid", "[]", '{}', '{"items": null}',
    '{"items": [], "settings": null}',
    '{"items": [], "settings": {"weight": 2}}',
    '{"items": [], "settings": {"mode": "unknown"}}'])
def test_invalid_report(tmp_path, content):
    path = tmp_path / "bad.json"
    path.write_text(content, encoding="utf-8")
    output = tmp_path / "board.html"
    with pytest.raises(ValueError):
        render(path, output)
    assert not output.exists()


def test_missing_report(tmp_path):
    with pytest.raises(OSError):
        render(tmp_path / "missing.json", tmp_path / "board.html")

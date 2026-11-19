from dataclasses import asdict
import json
from threading import Barrier

import pytest

from prompt_token_saver import pipeline
from prompt_token_saver.check_meaning import GapRule
from prompt_token_saver.embed import HashEmbedder
from prompt_token_saver.store import MemoryStore
from prompt_token_saver.summarize import ExtractiveSummarizer, TruncatingFakeSummarizer
from prompt_token_saver.surprise import IdfScorer
from prompt_token_saver.text import split_sentences
from prompt_token_saver.types import Summary


SOURCE = "the synthetic station recorded 42 samples."


class InventingSummarizer:
    def summarize(self, chunks, max_sentences):
        text = chunks[0].text + " purple dragons teleport across galaxies."
        return Summary("candidate", text,
                       [sentence for sentence, _, _ in split_sentences(text)], "model")


class BrokenSummarizer:
    def summarize(self, chunks, max_sentences):
        raise RuntimeError("synthetic failure")


def execute(summarizer=None, docs=None, **kwargs):
    docs = {"synthetic": SOURCE} if docs is None else docs
    embedder = HashEmbedder()
    return pipeline.run(
        docs, embedder=embedder, store=MemoryStore(), summarizer=summarizer,
        scorer=IdfScorer(list(docs.values())),
        meaning_rule=kwargs.pop("meaning_rule", GapRule.default_for(embedder.model_id)),
        **kwargs)


def test_extractive_default_and_json(tmp_path):
    report = execute()
    item, = report.items
    assert item.decision == "pass"
    assert item.final_text == SOURCE
    assert item.final_score == 1
    assert report.token_counts == {"codepoints": {"original": len(SOURCE), "final": len(SOURCE)}, "tokens": None}
    assert report.savings_rate == 0
    assert report.decision_counts == {"pass": 1, "flag": 0, "fallback": 0}
    assert report.settings["embedder_id"].startswith("hash-")
    assert report.settings["scorer_id"] == "IdfScorer"
    assert report.settings["threshold_version"]
    path = tmp_path / "output" / "report.json"
    report.to_json(path)
    assert json.loads(path.read_text(encoding="utf-8")) == asdict(report)


def test_anchor_detects_removed_number():
    item, = execute(TruncatingFakeSummarizer(), mode="anchor").items
    assert not item.checks[1].passed
    assert item.decision == "fallback"
    assert item.final_text == SOURCE
    assert "42" not in item.summary.text


@pytest.mark.parametrize("mode,decision", [
    ("meaning", "fallback"), ("anchor", "pass"),
    ("both", "fallback"), ("flag", "flag"),
])
def test_modes_with_invented_sentence(mode, decision):
    item, = execute(InventingSummarizer(), mode=mode, weight=0.25).items
    a, b = item.checks
    assert not a.passed
    assert b.passed
    assert item.decision == decision
    assert item.final_score == pytest.approx(0.75 * a.score + 0.25 * b.score)
    assert item.final_text == (SOURCE if decision == "fallback" else item.summary.text)


@pytest.mark.parametrize("mode,decision", [
    ("meaning", "pass"), ("anchor", "fallback"),
    ("both", "fallback"), ("flag", "flag"),
])
def test_modes_with_anchor_failure(mode, decision):
    item, = execute(TruncatingFakeSummarizer(), mode=mode,
                    meaning_rule=GapRule(-1, 0, "synthetic-permissive")).items
    assert item.checks[0].passed
    assert not item.checks[1].passed
    assert item.decision == decision


@pytest.mark.parametrize("mode", ["meaning", "anchor", "both", "flag"])
def test_summarizer_exception_always_falls_back(mode):
    item, = execute(BrokenSummarizer(), mode=mode).items
    assert item.decision == "fallback"
    assert item.final_text == SOURCE
    assert item.summary.method == "extractive"
    assert item.checks[0].details == {"error": "summarizer_exception"}


def test_parallel_checks_match_sequential(monkeypatch):
    gate = Barrier(2)
    meaning, anchor = pipeline.check_meaning, pipeline.check_anchors
    sequential = []

    def parallel_meaning(*args):
        gate.wait(timeout=5)
        result = meaning(*args)
        sequential.append(meaning(*args))
        return result

    def parallel_anchor(*args):
        gate.wait(timeout=5)
        return anchor(*args)

    monkeypatch.setattr(pipeline, "check_meaning", parallel_meaning)
    monkeypatch.setattr(pipeline, "check_anchors", parallel_anchor)
    item, = execute().items
    assert item.checks[0] == sequential[0]
    from prompt_token_saver.surprise import extract_anchors
    assert item.checks[1] == anchor(item.summary, extract_anchors(IdfScorer([SOURCE]).score(SOURCE)))


def test_source_embedding_batch_is_reused():
    class RecordingEmbedder(HashEmbedder):
        def __init__(self):
            super().__init__()
            self.calls = []

        def embed(self, texts):
            self.calls.append(list(texts))
            return super().embed(texts)

    embedder = RecordingEmbedder()
    store = MemoryStore()
    report = pipeline.run({"a": SOURCE, "b": SOURCE}, embedder=embedder,
                          store=store, summarizer=None, scorer=IdfScorer([SOURCE]),
                          meaning_rule=GapRule.default_for(embedder.model_id))
    assert embedder.calls == [[SOURCE]]
    assert len(report.items) == 1
    assert store.get("a:0").text == SOURCE
    assert store.get("b:0").text == SOURCE


def test_empty_documents():
    report = execute(docs={"empty": "  "})
    assert report.items == []
    assert report.savings_rate == 1
    assert report.token_counts == {"codepoints": {"original": 2, "final": 0}, "tokens": None}


@pytest.mark.parametrize("options", [
    {"mode": "unknown"}, {"weight": -0.1}, {"weight": 1.1},
    {"weight": float("nan")}, {"weight": float("inf")},
    {"group_threshold": 2}, {"max_sentences": -1}, {"max_sentences": True},
])
def test_invalid_settings(options):
    with pytest.raises(ValueError):
        execute(**options)


@pytest.mark.parametrize("weight", [0, 1])
def test_weight_endpoints_do_not_change_decision(weight):
    item, = execute(InventingSummarizer(), weight=weight).items
    assert item.decision == "fallback"
    assert item.final_score == item.checks[weight].score


def test_zero_sentence_limit_uses_real_extraction():
    report = execute(max_sentences=0)
    assert report.items[0].final_text == ""
    assert report.savings_rate == 1


def test_extractive_fallback_selects_original_sentences():
    source = "small robots count 12 stones. small robots count 15 stones. birds sing softly."
    item, = execute(BrokenSummarizer(), docs={"synthetic": source}, max_sentences=1).items
    expected = ExtractiveSummarizer(HashEmbedder()).summarize(
        [pipeline.chunk_text("synthetic", source)[0]], 1)
    assert expected.text in source
    assert item.final_text == ""
    assert any(not check.passed for check in item.fallback_checks)

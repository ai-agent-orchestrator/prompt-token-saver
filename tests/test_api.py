"""Public API integration tests using the real local pipeline."""

from dataclasses import asdict
import json
import subprocess
import sys

import pytest

import prompt_token_saver
from prompt_token_saver import RunReport, compress, compressed_text, summary_line
from prompt_token_saver import api, pipeline
from prompt_token_saver.check_meaning import GapRule
from prompt_token_saver.embed import HashEmbedder
from prompt_token_saver.store import MemoryStore
from prompt_token_saver.summarize import ExtractiveSummarizer, TruncatingFakeSummarizer
from prompt_token_saver.surprise import IdfScorer


SOURCE = "the synthetic station recorded 42 samples."


def test_string_input_and_public_exports():
    report = compress(SOURCE)
    assert isinstance(report, RunReport)
    assert report.items[0].source_chunk_ids == ["doc-1:0"]
    assert compressed_text(report) == SOURCE
    assert set(prompt_token_saver.__all__) == {
        "compress", "compressed_text", "summary_line", "RunReport",
    }
    assert report.settings["meaning_rule"] == asdict(
        GapRule.default_for(HashEmbedder().model_id))
    assert report.settings["scorer_id"] == "IdfScorer"


def test_dictionary_preserves_document_ids_and_item_order():
    docs = {"station": SOURCE, "garden": "violet flowers bloom beside quiet lakes."}
    report = compress(docs, group_threshold=1)
    assert [item.source_chunk_ids for item in report.items] == [
        ["station:0"], ["garden:0"],
    ]
    assert compressed_text(report) == "\n\n".join(docs.values())
    assert docs == {"station": SOURCE, "garden": "violet flowers bloom beside quiet lakes."}


@pytest.mark.parametrize("docs", ["", " \n\t", {}, {"empty": ""},
                                  {"a": " ", "b": "\n"}])
def test_empty_input_raises(docs):
    with pytest.raises(ValueError, match="nonblank"):
        compress(docs)


@pytest.mark.parametrize("docs", [None, [], 42, {1: SOURCE}, {"a": None}])
def test_invalid_input_types(docs):
    with pytest.raises(TypeError):
        compress(docs)


def test_blank_documents_can_accompany_nonblank_text():
    report = compress({"blank": " ", "station": SOURCE})
    assert report.items[0].source_chunk_ids == ["station:0"]
    assert compressed_text(report) == SOURCE


@pytest.mark.parametrize("mode,decision", [
    ("meaning", "pass"), ("anchor", "fallback"),
    ("both", "fallback"), ("flag", "flag"),
])
def test_modes_and_weight_reach_pipeline(mode, decision):
    report = compress(SOURCE, mode=mode, weight=0.25,
                      summarizer=TruncatingFakeSummarizer(),
                      meaning_rule=GapRule(-1, 0, "synthetic-permissive"))
    item, = report.items
    assert item.decision == decision
    assert report.settings["mode"] == mode
    assert report.settings["weight"] == 0.25
    assert item.final_score == pytest.approx(
        0.75 * item.checks[0].score + 0.25 * item.checks[1].score)


class FalsyComponent:
    def __bool__(self):
        return False


def test_injected_components_replace_defaults(monkeypatch):
    class RecordingEmbedder(FalsyComponent, HashEmbedder):
        def embed(self, texts):
            calls.append("embed")
            return super().embed(texts)

    class RecordingStore(FalsyComponent, MemoryStore):
        def add(self, *args, **kwargs):
            calls.append("add")
            return super().add(*args, **kwargs)

    class RecordingSummarizer(FalsyComponent, ExtractiveSummarizer):
        def summarize(self, chunks, max_sentences):
            calls.append(("summarize", max_sentences))
            return super().summarize(chunks, max_sentences)

    class RecordingScorer(FalsyComponent, IdfScorer):
        def score(self, text):
            calls.append(("score", text))
            return super().score(text)

    class FalsyRule(FalsyComponent, GapRule):
        pass

    calls = []
    embedder = RecordingEmbedder(dim=32)
    store = RecordingStore(model_id=embedder.model_id)
    summarizer = RecordingSummarizer(embedder)
    scorer = RecordingScorer([SOURCE])
    rule = FalsyRule(-1, 0, "synthetic-injected")

    def unexpected_default(*args, **kwargs):
        pytest.fail("An injected component was replaced by a default")

    for name in ("HashEmbedder", "MemoryStore", "ExtractiveSummarizer", "IdfScorer"):
        monkeypatch.setattr(api, name, unexpected_default)
    monkeypatch.setattr(GapRule, "default_for", unexpected_default)
    report = compress(SOURCE, embedder=embedder, store=store,
                      summarizer=summarizer, scorer=scorer, meaning_rule=rule,
                      max_sentences=1, group_threshold=0.75)
    assert "embed" in calls
    assert "add" in calls
    assert ("summarize", 1) in calls
    assert ("score", SOURCE) in calls
    assert store.get("doc-1:0").text == SOURCE
    assert report.settings["embedder_id"] == embedder.model_id
    assert report.settings["meaning_rule"] == asdict(rule)
    assert report.settings["group_threshold"] == 0.75
    assert compressed_text(report) == SOURCE


def test_partial_injection_uses_embedder_identifier_for_defaults():
    embedder = HashEmbedder(dim=32)
    report = compress(SOURCE, embedder=embedder)
    assert report.settings["embedder_id"] == embedder.model_id
    assert report.settings["meaning_rule"] == asdict(GapRule.default_for(embedder.model_id))
    assert compressed_text(report) == SOURCE


def test_custom_model_requires_calibrated_rule():
    embedder = HashEmbedder()
    embedder.model_id = "synthetic-custom-model"
    with pytest.raises(ValueError, match="calibrated GapRule"):
        compress(SOURCE, embedder=embedder)
    report = compress(SOURCE, embedder=embedder,
                      meaning_rule=GapRule(-1, 0, "synthetic-calibrated"))
    assert report.items[0].decision == "pass"


def test_compressed_text_keeps_fallback_source():
    report = compress(SOURCE, summarizer=TruncatingFakeSummarizer(), mode="anchor")
    item, = report.items
    assert item.decision == "fallback"
    assert "42" not in item.summary.text
    assert compressed_text(report) == item.final_text == SOURCE


def test_deterministic_reports_and_direct_pipeline_equivalence():
    docs = {"a": SOURCE, "b": "small robots count 15 stones. birds sing softly."}
    first = compress(docs, max_sentences=1)
    assert first == compress(docs, max_sentences=1)
    embedder = HashEmbedder()
    assert first == pipeline.run(
        docs, embedder=embedder, store=MemoryStore(model_id=embedder.model_id),
        summarizer=ExtractiveSummarizer(embedder), scorer=IdfScorer(list(docs.values())),
        meaning_rule=GapRule.default_for(embedder.model_id), max_sentences=1)


@pytest.mark.parametrize("options", [
    {"mode": "unknown"}, {"weight": -1}, {"weight": float("nan")},
    {"max_sentences": -1}, {"group_threshold": 2},
])
def test_invalid_settings_propagate(options):
    with pytest.raises(ValueError):
        compress(SOURCE, **options)


def test_summary_line_counts_and_savings():
    report = compress(SOURCE)
    assert summary_line(report) == (
        "in 6 tokens -> out 6 tokens (saved 0%), pass 1 / fallback 0 / flag 0")
    empty = compress(SOURCE, max_sentences=0)
    assert compressed_text(empty) == ""
    assert summary_line(empty) == (
        "in 6 tokens -> out 0 tokens (saved 100%), pass 0 / fallback 1 / flag 0")
    fallback = compress(SOURCE, summarizer=TruncatingFakeSummarizer(), mode="anchor")
    assert summary_line(fallback).endswith("pass 0 / fallback 1 / flag 0")
    flagged = compress(SOURCE, summarizer=TruncatingFakeSummarizer(), mode="flag")
    assert summary_line(flagged).endswith("pass 0 / fallback 0 / flag 1")


def test_text_helper_handles_empty_report():
    embedder = HashEmbedder()
    report = pipeline.run(
        {}, embedder=embedder, store=MemoryStore(model_id=embedder.model_id),
        summarizer=None, scorer=IdfScorer([]),
        meaning_rule=GapRule.default_for(embedder.model_id))
    assert compressed_text(report) == ""
    assert summary_line(report) == (
        "in 0 tokens -> out 0 tokens (saved 0%), pass 0 / fallback 0 / flag 0")


def test_import_loads_only_standard_library_and_package():
    code = """
import sys
before = set(sys.modules)
import prompt_token_saver
import json
extra = {name.split('.')[0] for name in set(sys.modules) - before}
unexpected = extra - sys.stdlib_module_names - {'prompt_token_saver'}
assert not unexpected, sorted(unexpected)
assert not {'chromadb', 'transformers', 'torch'} & sys.modules.keys()
print(json.dumps(sorted(prompt_token_saver.__all__)))
"""
    result = subprocess.run([sys.executable, "-S", "-c", code],
                            capture_output=True, text=True, check=True)
    assert json.loads(result.stdout) == sorted(prompt_token_saver.__all__)

"""An offline comparison using only invented notes and the real pipeline."""

from dataclasses import asdict
from importlib.resources import files
import json
from pathlib import Path

from ..board import render
from ..check_meaning import GapRule
from ..embed import HashEmbedder
from ..pipeline import run
from ..store import MemoryStore
from ..summarize import ExtractiveSummarizer, TruncatingFakeSummarizer
from ..surprise import IdfScorer, extract_anchors
from ..text import chunk_text


class _OptionalModel:
    """Stop contacting a local model after its first failed request."""

    def __init__(self, summarizer):
        self.summarizer = summarizer
        self.failed = False

    def summarize(self, chunks, max_sentences):
        if self.failed:
            raise RuntimeError("Local model unavailable")
        try:
            return self.summarizer.summarize(chunks, max_sentences)
        except Exception:
            self.failed = True
            raise


def load_notes() -> dict[str, str]:
    """Read the two bundled UTF-8 examples without accessing user documents."""
    return {name: files(__package__).joinpath(name).read_text(encoding="utf-8")
            for name in ("notes_ko.md", "notes_en.md")}


def create_demo(out: str | Path = "pts-demo", *, summarizer=None) -> tuple[Path, Path, bool]:
    """Write a comparison; B failures in the broken arm retain the full source.

    The optional model is an additional arm, so the first example is always
    deterministic. Model failures use the pipeline's extraction fallback.
    Return whether that optional arm encountered a summarizer failure.
    """
    docs = load_notes()
    embedder = HashEmbedder()
    scorer = IdfScorer(list(docs.values()))
    rule = GapRule.default_for(embedder.model_id)
    chunks = {chunk.id: chunk for doc_id, text in docs.items()
              for chunk in chunk_text(doc_id, text)}
    arms = [("TruncatingFakeSummarizer", TruncatingFakeSummarizer()),
            ("ExtractiveSummarizer", ExtractiveSummarizer(embedder))]
    if summarizer is not None:
        arms.append(("OllamaSummarizer", _OptionalModel(summarizer)))
    reports, items = [], []
    model_failed = False
    for label, arm in arms:
        report = run(docs, embedder=embedder, store=MemoryStore(),
                     summarizer=arm, scorer=scorer, meaning_rule=rule)
        reports.append(report)
        arm_items = []
        for result in report.items:
            item = asdict(result)
            sources = [chunks[key] for key in result.source_chunk_ids]
            source_text = "\n\n".join(chunk.text for chunk in sources)
            item["source_chunks"] = [asdict(chunk) for chunk in sources]
            item["anchors"] = [asdict(anchor) for anchor in
                               extract_anchors(scorer.score(source_text))]
            item["group_id"] = f"{label} / {item['group_id']}"
            item["summary"]["group_id"] = item["group_id"]
            item["demo_arm"] = label
            if label == "TruncatingFakeSummarizer" and any(
                    check.name == "anchor" and not check.passed for check in result.checks):
                item["final_text"] = source_text
            if label == "OllamaSummarizer" and any(
                    check.name == "summarizer" for check in result.checks):
                model_failed = True
            arm_items.append(item)
        if label == "TruncatingFakeSummarizer":
            # Show a factual failure first even if grouping changes in the future.
            arm_items.sort(key=lambda item: not any(
                check["name"] == "anchor" and not check["passed"]
                for check in item["checks"]))
        items.extend(arm_items)
        if model_failed:
            break
    data = asdict(reports[0])
    original = sum(report.token_counts["original"] for report in reports)
    final = sum(len(item["final_text"].split()) for item in items)
    data.update(items=items,
                token_counts={**data["token_counts"], "original": original, "final": final},
                savings_rate=1 - final / original if original else 0.0,
                decision_counts={name: sum(item["decision"] == name for item in items)
                                 for name in ("pass", "flag", "fallback")})
    data["settings"].update(
        demo_arms=[label for label, _ in arms],
        demo_fallback="Full source on broken-arm B failure",
        demo_counts="Source counts repeat once per comparison arm",
    )
    output = Path(out)
    output.mkdir(parents=True, exist_ok=True)
    report_path, board_path = output / "report.json", output / "board.html"
    report_path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False)
                           + "\n", encoding="utf-8")
    render(report_path, board_path)
    return report_path, board_path, model_failed

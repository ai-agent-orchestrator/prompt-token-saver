"""Small, dependency-free entry points for document compression."""

from . import pipeline
from .check_meaning import GapRule
from .embed import HashEmbedder
from .pipeline import RunReport
from .store import MemoryStore
from .summarize import ExtractiveSummarizer
from .surprise import IdfScorer


def compress(docs: dict[str, str] | str, *, mode="both", weight=0.5,
             max_sentences=3, group_threshold=0.55, embedder=None, store=None,
             summarizer=None, scorer=None, meaning_rule=None) -> RunReport:
    """Run the pipeline with local defaults; reject empty or blank input.

    A single string uses document ID ``doc-1``. Only components set to None
    are replaced. Custom embedding models may need an explicit GapRule.
    """
    if isinstance(docs, str):
        docs = {"doc-1": docs}
    if not isinstance(docs, dict):
        raise TypeError("docs must be a string or a dictionary of strings")
    if any(not isinstance(key, str) or not isinstance(text, str)
           for key, text in docs.items()):
        raise TypeError("Document IDs and texts must be strings")
    if not docs or not any(text.strip() for text in docs.values()):
        raise ValueError("docs must contain nonblank text")

    if embedder is None:
        embedder = HashEmbedder()
    if store is None:
        store = MemoryStore(model_id=embedder.model_id)
    if summarizer is None:
        summarizer = ExtractiveSummarizer(embedder)
    if scorer is None:
        scorer = IdfScorer(list(docs.values()))
    if meaning_rule is None:
        meaning_rule = GapRule.default_for(embedder.model_id)
    return pipeline.run(
        docs, embedder=embedder, store=store, summarizer=summarizer,
        scorer=scorer, meaning_rule=meaning_rule, mode=mode, weight=weight,
        max_sentences=max_sentences, group_threshold=group_threshold,
    )


def compressed_text(report: RunReport) -> str:
    """Join the chosen final text of each item, in report order."""
    return "\n\n".join(item.final_text for item in report.items)


def summary_line(report: RunReport) -> str:
    """Format approximate token counts, rounded savings and decisions for logs."""
    return (
        f"in {report.token_counts['original']} tokens -> "
        f"out {report.token_counts['final']} tokens "
        f"(saved {report.savings_rate:.0%}), "
        f"pass {report.decision_counts['pass']} / "
        f"fallback {report.decision_counts['fallback']} / "
        f"flag {report.decision_counts['flag']}"
    )

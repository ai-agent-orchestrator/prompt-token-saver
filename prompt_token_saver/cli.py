"""Command-line entry point."""

import argparse
from dataclasses import asdict
import json
import sys
from pathlib import Path
import webbrowser

from . import __version__
from .board import render
from .check_meaning import GapRule
from .embed import HashEmbedder, OllamaEmbedder
from .pipeline import run
from .store import MemoryStore
from .summarize import OllamaSummarizer
from .surprise import IdfScorer, LogprobScorer, extract_anchors
from .text import chunk_text


class _BoardScorer:
    """Retain the actual scorer output without a second model evaluation."""

    def __init__(self, scorer):
        self.scorer = scorer
        self.model_id = (getattr(scorer, "model_id", None)
                         or getattr(scorer, "model_name", None)
                         or type(scorer).__name__)
        self.scored = {}

    def score(self, text):
        result = self.scorer.score(text)
        self.scored[text] = result
        return result


def _run(args):
    files = set()
    for name in args.inputs:
        path = Path(name)
        if not path.exists():
            raise ValueError(f"Input does not exist: {path}")
        candidates = path.rglob("*") if path.is_dir() else [path]
        for candidate in candidates:
            if candidate.is_file() and candidate.suffix.lower() in (".txt", ".md"):
                files.add(candidate.resolve())
    if not files:
        raise ValueError("No .txt or .md input files")
    docs = {str(path): path.read_text(encoding="utf-8") for path in sorted(files)}
    if args.embed == "hash":
        embedder = HashEmbedder()
        rule = GapRule.default_for(embedder.model_id)
    elif args.embed.startswith("ollama:"):
        embedder = OllamaEmbedder(args.embed.removeprefix("ollama:"))
        rule = GapRule(0.8, 0.1, "cli-ollama-uncalibrated-v1")
    else:
        raise ValueError("embed must be hash or ollama:<name>")
    if args.scorer == "idf":
        scorer = IdfScorer(list(docs.values()))
    elif args.scorer.startswith("logprob:") and args.scorer.removeprefix("logprob:").strip():
        scorer = LogprobScorer(args.scorer.removeprefix("logprob:"))
    else:
        raise ValueError("scorer must be idf or logprob:<name>")
    scorer = _BoardScorer(scorer)
    report = run(docs, embedder=embedder, store=MemoryStore(),
                 summarizer=OllamaSummarizer(args.model) if args.model else None,
                 scorer=scorer, meaning_rule=rule, mode=args.mode, weight=args.weight)
    output = Path(args.out) / "report.json"
    data = asdict(report)
    chunks = {chunk.id: chunk for doc_id, text in docs.items()
              for chunk in chunk_text(doc_id, text)}
    for item in data["items"]:
        sources = [chunks[key] for key in item["source_chunk_ids"]]
        item["source_chunks"] = [asdict(chunk) for chunk in sources]
        source_text = "\n\n".join(chunk.text for chunk in sources)
        item["anchors"] = [asdict(anchor) for anchor in
                           extract_anchors(scorer.scored.get(source_text, []))]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False)
                      + "\n", encoding="utf-8")
    print(f"{output} (코드포인트 기준 감소율 {report.savings_rate:.1%})")
    if args.board:
        board_path = output.with_name("board.html")
        render(output, board_path)
        print(board_path)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pts", description="Prompt token saver")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    commands = parser.add_subparsers(dest="command")
    brief_parser = commands.add_parser("brief", help="Create a brief within 300 codepoints and one third of source")
    brief_parser.add_argument("file")
    brief_parser.add_argument("--stage2", action="store_true")
    brief_parser.add_argument("--model")
    brief_parser.add_argument("--json", action="store_true")
    run_parser = commands.add_parser("run", help="Summarize and check local text files")
    run_parser.add_argument("inputs", nargs="*")
    run_parser.add_argument("--out", default="pts-out")
    run_parser.add_argument("--mode", choices=("meaning", "anchor", "both", "flag"), default="both")
    run_parser.add_argument("--model")
    run_parser.add_argument("--embed", default="hash")
    run_parser.add_argument("--scorer", default="idf")
    run_parser.add_argument("--weight", type=float, default=0.5)
    run_parser.add_argument("--board", action="store_true", help="Generate board.html")
    demo_parser = commands.add_parser("demo", help="Compare built-in synthetic notes offline")
    demo_parser.add_argument("--out", default="pts-demo")
    demo_parser.add_argument("--open", action="store_true", help="Open board.html in a browser")
    demo_parser.add_argument("--model", help="Also try an installed local Ollama model")
    board_parser = commands.add_parser("board", help="Review a JSON report offline")
    board_parser.add_argument("report", nargs="?")
    board_parser.add_argument("--out", default="board.html")
    board_parser.add_argument("--open", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code)
    if args.command == "brief":
        from .api import summarize_brief
        try:
            text = Path(args.file).read_text(encoding="utf-8")
            generator = OllamaSummarizer(args.model) if args.model else None
            result = summarize_brief(text, generator=generator)
            if args.stage2 and result["status"] == "OK":
                result = summarize_brief(text, generator=generator, stage1=result)
            if args.json:
                print(json.dumps(result, ensure_ascii=False, allow_nan=False))
            elif result["status"] == "OK":
                print(result["body"])
            else:
                print(result["status"], file=sys.stderr)
            return 0 if result["status"] == "OK" else 2
        except (OSError, ValueError, RuntimeError, TypeError):
            print("pts brief: cannot read source or run engine", file=sys.stderr)
            return 2
    if args.command == "demo":
        from .demo import create_demo

        try:
            report_path, board_path, model_failed = create_demo(
                args.out, summarizer=OllamaSummarizer(args.model)
                if args.model is not None else None)
            print(report_path)
            print(board_path)
            print("TruncatingFakeSummarizer: B FAIL -> fallback (rechecked extraction); "
                  "ExtractiveSummarizer: comparison")
            if model_failed:
                print("Local Ollama model unavailable; offline comparison is ready. "
                      "Start Ollama and install the selected model to add model results.")
            if args.open:
                webbrowser.open(board_path.resolve().as_uri())
            return 0
        except (OSError, ValueError, RuntimeError, ImportError) as exc:
            print(f"pts demo: {exc}")
            return 2
    if args.command == "board" and args.report:
        try:
            render(args.report, args.out)
            print(args.out)
            if args.open:
                webbrowser.open(Path(args.out).resolve().as_uri())
            return 0
        except (OSError, ValueError, TypeError, KeyError) as exc:
            print(f"pts board: {exc}")
            return 2
    if args.command == "run" and args.inputs:
        try:
            return _run(args)
        except (OSError, ValueError, RuntimeError, ImportError) as exc:
            print(f"pts run: {exc}")
            return 2
    if args.command:
        print(f"{args.command}: 아직 없음")
        return 2
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

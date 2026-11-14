"""Command-line entry point."""

import argparse
from pathlib import Path

from . import __version__
from .check_meaning import GapRule
from .embed import HashEmbedder, OllamaEmbedder
from .pipeline import run
from .store import MemoryStore
from .summarize import OllamaSummarizer
from .surprise import IdfScorer, LogprobScorer


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
    report = run(docs, embedder=embedder, store=MemoryStore(),
                 summarizer=OllamaSummarizer(args.model) if args.model else None,
                 scorer=scorer, meaning_rule=rule, mode=args.mode, weight=args.weight)
    output = Path(args.out) / "report.json"
    report.to_json(output)
    print(f"{output} (공백 분리 근사, 절감률 {report.savings_rate:.1%})")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pts", description="Prompt token saver")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    commands = parser.add_subparsers(dest="command")
    run_parser = commands.add_parser("run", help="Summarize and check local text files")
    run_parser.add_argument("inputs", nargs="*")
    run_parser.add_argument("--out", default="pts-out")
    run_parser.add_argument("--mode", choices=("meaning", "anchor", "both", "flag"), default="both")
    run_parser.add_argument("--model")
    run_parser.add_argument("--embed", default="hash")
    run_parser.add_argument("--scorer", default="idf")
    run_parser.add_argument("--weight", type=float, default=0.5)
    for name in ("demo", "board"):
        commands.add_parser(name, help="아직 없음")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code)
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

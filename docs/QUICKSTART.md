# Three commands to the offline demo

With Python 3.10+ and Git installed, run these three lines (the clone line also
enters the checkout):

```sh
git clone https://github.com/ai-agent-orchestrator/prompt-token-saver.git; cd prompt-token-saver
pip install -e .
pts demo --open
```

The first line works in PowerShell and POSIX shells. Installation uses pip;
the demo itself needs no network, GPU, account, or model. Omit `--open` on a
machine without a browser. Use `pts demo --out another-folder` to choose the
output directory. Existing report and board files there are replaced.

Expected output:

```text
pts-demo/report.json
pts-demo/board.html
TruncatingFakeSummarizer: B FAIL -> fallback (full source); ExtractiveSummarizer: comparison
```

Windows prints paths with backslashes. The first board card shows the deliberately
broken summary, the numbers missed by check B, and the full source kept by the
demo's fallback policy. Subsequent cards include the real extractive summarizer
for comparison. Both arms use the real grouping and checking pipeline, hash
embeddings, and IDF scoring. Hash embeddings are a deterministic demonstration,
not a semantic language model. Totals count the input once per comparison arm.
Both bundled notes are invented and marked `synthetic example` on their first line.

# Optional local model

Install and start Ollama separately, then download the model explicitly:

```sh
ollama pull qwen3:1.7b
pts demo --model qwen3:1.7b --open
```

The model download needs network access. The demo only contacts local Ollama
when `--model` is supplied. If it cannot use that model, it prints guidance and
still produces the offline comparison. Model results are an additional arm;
the broken-summary example stays first.

For your own UTF-8 `.txt` or `.md` files in a `notes/` directory:

```sh
pts run notes/ --model qwen3:1.7b --board
```

This writes `pts-out/report.json` and `pts-out/board.html`. The repository's MIT
license covers this tool, while model licenses apply separately. Qwen3 uses
Apache-2.0. Llama models have their own license; include the required
"Built with Llama" attribution when distributing a product using them and check
the terms for the particular model version.

Use `pts --help`, `pts demo --help`, and `pts run --help` for command options.
The `ten-minutes` workflow checks Ubuntu and Windows, measuring installation,
the full test suite, and the default demo together against a 600-second budget.

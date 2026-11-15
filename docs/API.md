# Python API

```python
from prompt_token_saver import compress, compressed_text, summary_line
docs = {"station": "The synthetic station recorded 42 samples."}
report = compress(docs)
print(compressed_text(report))
print(summary_line(report))
```

`compress` accepts a document-ID-to-text dictionary or a string (ID `doc-1`).
Empty or entirely blank input raises `ValueError`. Defaults run locally using
only the standard library. Options are `mode` (`meaning`, `anchor`, `both`,
`flag`; default `both`), `weight=0.5`, `max_sentences=3`, and
`group_threshold=0.55`. Inject `embedder`, `store`, `summarizer`, `scorer`, or
`meaning_rule` to replace defaults; custom embedding models require a calibrated
`GapRule` when no default exists.

The exported `RunReport` contains ordered `items` (candidate summaries, checks,
decisions and `final_text`), `settings`, approximate whitespace-based
`token_counts`, fractional `savings_rate`, and `decision_counts`.
`compressed_text` joins each item's `final_text` with a blank line, preserving
the pipeline's extractive fallback. `summary_line` returns one log line with
input/output counts, savings rounded to a whole percent, and decision counts.
Use `report.to_json(path)` to save the report.

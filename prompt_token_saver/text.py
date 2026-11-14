"""Deterministic text helpers with offsets into the original Python string."""

import re
from decimal import Decimal

from .types import Chunk


_BOUNDARY = re.compile(r'''[.?!。]+["'”’」』)]*(?=\s|$)|\r?\n[\t ]*\r?\n''')
_ABBREVIATION = re.compile(
    r"(?:\b(?:[A-Za-z]\.){2,}|\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc)\.)$",
    re.IGNORECASE,
)
_JOSA = ("에서", "으로", "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만")


def split_sentences(text: str) -> list[tuple[str, int, int]]:
    """Split terminal punctuation and blank lines, preserving exact offsets.

    Decimal points, dotted initialisms (e.g., U.S.) and common English
    abbreviations stay intact. Abbreviations at paragraph ends remain part of
    that paragraph; this deliberately uses heuristics rather than a language model.
    Whitespace surrounding each sentence is excluded from its span.
    """
    result: list[tuple[str, int, int]] = []
    start = 0

    def append_span(end: int) -> None:
        left, right = start, end
        while left < right and text[left].isspace():
            left += 1
        while right > left and text[right - 1].isspace():
            right -= 1
        if left < right:
            result.append((text[left:right], left, right))

    for match in _BOUNDARY.finditer(text):
        if match.group().startswith(".") and _ABBREVIATION.search(text[:match.start() + 1]):
            continue
        append_span(match.end() if not match.group().startswith(("\n", "\r")) else match.start())
        start = match.end()
    append_span(len(text))
    return result


def strip_josa(word: str) -> str:
    """Remove one common Korean particle only if at least two Hangul letters remain."""
    if not re.fullmatch(r"[가-힣]+", word):
        return word
    for suffix in _JOSA:
        if word.endswith(suffix):
            return word[:-len(suffix)] if len(word) - len(suffix) >= 2 else word
    return word


def tokens(text: str) -> list[str]:
    """Return lowercase Hangul, ASCII letter and digit runs, stripping particles."""
    return [strip_josa(word) for word in re.findall(r"[가-힣]+|[a-z]+|[0-9]+", text.lower())]


def normalize_number(s: str) -> str:
    """Normalize commas, spacing, case and redundant decimal zeros.

    Covered forms include 12%, 12 %, 4.1B, 41억, 4,100,000, -1,200.50
    and +0012.00. Percent and unit suffixes are preserved (B becomes b).
    Units are not converted: 4.1B and 41억 retain distinct representations.
    Unrecognized forms are returned stripped and lowercase.
    """
    value = s.strip().lower()
    match = re.fullmatch(r"([+-]?(?:[0-9][0-9,]*(?:\.[0-9]+)?|\.[0-9]+))\s*([a-z가-힣%]*)", value)
    if not match:
        return value
    number = Decimal(match.group(1).replace(",", ""))
    normalized = format(number, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    if number == 0:
        normalized = "0"
    return normalized + match.group(2)


def chunk_text(doc_id: str, text: str, max_chars: int = 400) -> list[Chunk]:
    """Pack sentences into original-text spans with deterministic document-local IDs.

    A single sentence longer than max_chars is kept whole. Intervening original
    whitespace counts toward the limit and is preserved inside each chunk.
    """
    if max_chars <= 0:
        raise ValueError("max_chars must be positive")
    chunks: list[Chunk] = []
    start = end = None

    def emit() -> None:
        if start is not None and end is not None:
            chunks.append(Chunk(f"{doc_id}:{len(chunks)}", doc_id, text[start:end], start, end))

    for _, sentence_start, sentence_end in split_sentences(text):
        if start is not None and sentence_end - start > max_chars:
            emit()
            start = None
        if start is None:
            start = sentence_start
        end = sentence_end
    emit()
    return chunks

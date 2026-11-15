"""Dependency-free surprise estimates and optional local model token losses."""

from collections import Counter
from dataclasses import dataclass
import math
import re
from typing import Literal, Protocol

from .text import normalize_number, split_sentences, strip_josa


ScoredWord = tuple[str, int, int, float]
_WORDS = re.compile(
    r"[$€£¥₩]?[+-]?(?:[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|\.[0-9]+)"
    r"(?:\s*%|[a-zA-Z]+|조|억|만|천|백|원|명|개|년|월|일)?"
    r"|[A-Za-z_][A-Za-z_0-9]*|[가-힣]+"
)


def _words(text: str) -> list[tuple[str, int, int]]:
    return [(m.group(), m.start(), m.end()) for m in _WORDS.finditer(text)]


def _kind(word: str) -> Literal["number", "name", "term"]:
    if any(char.isdigit() for char in word):
        return "number"
    return "name" if re.match(r"[A-Z]", word) else "term"


def _norm(word: str) -> str:
    if _kind(word) == "number":
        # Currency is significant, while the numeric portion uses the shared helper.
        if word and word[0] in "$€£¥₩":
            return word[0] + normalize_number(word[1:])
        return normalize_number(word)
    return strip_josa(word).lower()


class SurpriseScorer(Protocol):
    def score(self, text: str) -> list[ScoredWord]:
        """Return words, original character offsets and nonnegative surprise."""
        ...


class IdfScorer:
    """Document-frequency self-information with simple factual-word bonuses."""

    def __init__(self, corpus_texts: list[str]):
        self.document_count = len(corpus_texts)
        self.document_frequency = Counter(
            norm for text in corpus_texts
            for norm in {_norm(word) for word, _, _ in _words(text)}
        )

    def score(self, text: str) -> list[ScoredWord]:
        words = _words(text)
        first_words = set()
        for sentence, start, _ in split_sentences(text):
            sentence_words = _words(sentence)
            if sentence_words:
                first_words.add(start + sentence_words[0][1])
        result = []
        for word, start, end in words:
            value = -math.log((self.document_frequency[_norm(word)] + 1)
                              / (self.document_count + 2))
            if _kind(word) == "number":
                value += 2.0
            if re.match(r"[A-Z]", word) and start not in first_words:
                value += 1.0
            if any(symbol in word for symbol in "%$€£¥₩"):
                value += 1.0
            result.append((word, start, end, value))
        return result


class LogprobScorer:
    """Mean causal token loss per word, using an already cached local model.

    Imports and model loading are lazy with respect to module import. No model
    downloads are performed. A BOS token predicts the first token when available;
    otherwise the first token has no causal loss and is excluded from the mean.
    """

    def __init__(self, model_name: str):
        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer
            import torch
        except ImportError as exc:
            raise RuntimeError(
                "LogprobScorer requires optional dependencies: "
                "pip install 'prompt-token-saver[logprob]'"
            ) from exc
        self.model_name = model_name
        self._torch = torch
        self._model_class = AutoModelForCausalLM
        self._tokenizer_class = AutoTokenizer
        self._model = self._tokenizer = None

    def score(self, text: str) -> list[ScoredWord]:
        words = _words(text)
        if not words:
            return []
        if self._model is None:
            self._tokenizer = self._tokenizer_class.from_pretrained(
                self.model_name, use_fast=True, local_files_only=True)
            self._model = self._model_class.from_pretrained(
                self.model_name, local_files_only=True)
            self._model.eval()
        encoded = self._tokenizer(text, return_offsets_mapping=True,
                                  add_special_tokens=False)
        offsets = encoded["offset_mapping"]
        ids = encoded["input_ids"]
        bos = self._tokenizer.bos_token_id
        if bos is not None:
            ids = [bos] + ids
            offsets = [(0, 0)] + offsets
        losses = []
        if len(ids) > 1:
            torch = self._torch
            inputs = torch.tensor([ids], dtype=torch.long)
            with torch.no_grad():
                logits = self._model(input_ids=inputs).logits
                losses = torch.nn.functional.cross_entropy(
                    logits[0, :-1], inputs[0, 1:], reduction="none").tolist()
        result = []
        for word, start, end in words:
            values = [loss for (left, right), loss in zip(offsets[1:], losses)
                      if left < end and right > start]
            result.append((word, start, end, sum(values) / len(values) if values else 0.0))
        return result


@dataclass(frozen=True)
class Anchor:
    text: str
    norm: str
    kind: Literal["number", "name", "term"]
    start: int
    end: int
    surprisal: float
    # Immediate left/right nonnumeric words, normalized for changed-number checks.
    context: tuple[str, str] = ("", "")


def extract_anchors(scored: list[ScoredWord], top_ratio: float = 0.15,
                    always: tuple[str, ...] = ("number",)) -> list[Anchor]:
    """Select ceil(ratio * word count) positions plus forced kinds, in source order.

    Ties use input order; repeated occurrences retain their individual offsets.
    Capitalized English words are name candidates, including sentence initials.
    """
    if not math.isfinite(top_ratio) or not 0 <= top_ratio <= 1:
        raise ValueError("top_ratio must be finite and in [0, 1]")
    if any(kind not in ("number", "name", "term") for kind in always):
        raise ValueError("always must contain number, name or term")
    selected = set(sorted(range(len(scored)), key=lambda i: (-scored[i][3], i))[
        :math.ceil(len(scored) * top_ratio)])
    result = []
    for index, (word, start, end, value) in enumerate(scored):
        kind = _kind(word)
        if index not in selected and kind not in always:
            continue
        context = tuple(
            _norm(scored[neighbor][0])
            if 0 <= neighbor < len(scored) and _kind(scored[neighbor][0]) != "number"
            else "" for neighbor in (index - 1, index + 1)
        )
        result.append(Anchor(word, _norm(word), kind, start, end, value, context))
    return result

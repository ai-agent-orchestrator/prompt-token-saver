"""Sentence-preserving extraction and an injectable local model adapter."""

import hashlib
import json
import math
import re
from typing import Literal, Protocol

from .embed import Embedder, _UrllibHTTP, cosine
from .text import split_sentences
from .types import Chunk, Summary


class Summarizer(Protocol):
    def summarize(self, chunks: list[Chunk], max_sentences: int) -> Summary: ...


class SummarizerError(Exception):
    """A local model request failed or returned an invalid response."""


DEFAULT_PROMPT_TEMPLATE = """Summarize the Korean or English source in at most {max_sentences} sentences.
Preserve numbers, names, dates, negations and conditional expressions exactly.
Write in the source language. Return only the summary without a heading.
한국어 또는 영어 원문을 최대 {max_sentences}문장으로 요약하세요.
숫자·이름·날짜·부정/조건 표현을 바꾸지 말고 보존하세요.
원문의 언어로 요약문만 작성하세요.

Source / 원문:
{text}"""


def _validate_limit(max_sentences: int) -> None:
    if isinstance(max_sentences, bool) or not isinstance(max_sentences, int) or max_sentences < 0:
        raise ValueError("max_sentences must be a nonnegative integer")


def _sentences(chunks: list[Chunk]) -> list[str]:
    return [sentence for chunk in chunks
            for sentence, _, _ in split_sentences(chunk.text)]


def _summary(chunks: list[Chunk], sentences: list[str],
             method: Literal["model", "extractive"]) -> Summary:
    # Match group_chunks IDs without clustering or requiring embeddings.
    ids = json.dumps([chunk.id for chunk in chunks], ensure_ascii=False)
    group_id = "group:" + hashlib.sha256(ids.encode("utf-8")).hexdigest()
    return Summary(group_id, " ".join(sentences), sentences, method)


class ExtractiveSummarizer:
    """Rank by mean cosine to all other sentences, then restore input order.

    Ties favor earlier sentences. Chunks must be supplied in source order;
    selected sentence strings are copied verbatim, including punctuation.
    A zero limit produces an empty summary; a negative limit is invalid.
    """

    def __init__(self, embedder: Embedder):
        self.embedder = embedder

    def summarize(self, chunks: list[Chunk], max_sentences: int) -> Summary:
        _validate_limit(max_sentences)
        sentences = _sentences(chunks)
        if not max_sentences:
            return _summary(chunks, [], "extractive")
        if len(sentences) <= max_sentences:
            return _summary(chunks, sentences, "extractive")
        vectors = self.embedder.embed(sentences)
        if len(vectors) != len(sentences):
            raise ValueError("Sentence and vector counts must match")
        similarities = [[] for _ in sentences]
        for i in range(len(sentences)):
            for j in range(i + 1, len(sentences)):
                score = cosine(vectors[i], vectors[j])
                similarities[i].append(score)
                similarities[j].append(score)
        scores = [math.fsum(values) / (len(sentences) - 1) for values in similarities]
        selected = sorted(sorted(range(len(sentences)), key=lambda i: (-scores[i], i))
                          [:max_sentences])
        return _summary(chunks, [sentences[i] for i in selected], "extractive")


class OllamaSummarizer:
    """Use POST /api/generate with an injectable post(url, json=...) client.

    The client returns a decoded JSON dictionary, as in OllamaEmbedder.
    Custom templates accept {text} and {max_sentences} format fields.
    Empty input and a zero limit avoid HTTP entirely.
    """

    def __init__(self, model: str, base_url: str = "http://localhost:11434",
                 http=None, prompt_template: str = DEFAULT_PROMPT_TEMPLATE):
        if not model.strip():
            raise ValueError("model must be nonempty")
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.http = http if http is not None else _UrllibHTTP()
        self.prompt_template = prompt_template

    def summarize(self, chunks: list[Chunk], max_sentences: int) -> Summary:
        _validate_limit(max_sentences)
        if not max_sentences or not _sentences(chunks):
            return _summary(chunks, [], "model")
        try:
            prompt = self.prompt_template.format(
                text="\n\n".join(chunk.text for chunk in chunks),
                max_sentences=max_sentences,
            )
            response = self.http.post(self.base_url + "/api/generate", json={
                "model": self.model, "prompt": prompt, "stream": False,
            })
            if not isinstance(response, dict) or not isinstance(response.get("response"), str):
                raise ValueError("Invalid model response")
            sentences = [sentence for sentence, _, _ in split_sentences(response["response"])]
            if not sentences:
                raise ValueError("Empty model response")
        except Exception as exc:
            raise SummarizerError("Ollama summarization failed") from exc
        return _summary(chunks, sentences[:max_sentences], "model")


class TruncatingFakeSummarizer:
    """데모용 가짜: deliberately remove numbers and percentages for checker demos."""

    def summarize(self, chunks: list[Chunk], max_sentences: int) -> Summary:
        _validate_limit(max_sentences)
        sentences = [re.sub(r"[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)|[%％]", "", sentence)
                     for sentence in _sentences(chunks)[:max_sentences]]
        return _summary(chunks, sentences, "model")

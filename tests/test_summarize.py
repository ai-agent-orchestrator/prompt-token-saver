import pytest

from prompt_token_saver.embed import HashEmbedder
from prompt_token_saver.group import group_chunks
from prompt_token_saver.summarize import (
    ExtractiveSummarizer,
    OllamaSummarizer,
    Summarizer,
    SummarizerError,
    TruncatingFakeSummarizer,
)
from prompt_token_saver.text import split_sentences
from prompt_token_saver.types import Chunk


def chunks(*texts):
    return [Chunk(f"합성:{i}", "합성", text, i * 100, i * 100 + len(text))
            for i, text in enumerate(texts)]


class FakeHTTP:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def post(self, url, json):
        self.calls.append((url, json))
        if self.error is not None:
            raise self.error
        return self.response


def test_extraction_centrality_verbatim_and_source_order():
    source = chunks("Rocket launch. Apple orchard.", "Apple orchard! Apple orchard?")
    summarizer: Summarizer = ExtractiveSummarizer(HashEmbedder())
    result = summarizer.summarize(source, 2)
    sentences = [s for chunk in source for s, _, _ in split_sentences(chunk.text)]
    assert result.sentences == ["Apple orchard.", "Apple orchard!"]
    assert all(s in sentences for s in result.sentences)
    assert [sentences.index(s) for s in result.sentences] == sorted(
        sentences.index(s) for s in result.sentences)
    assert result.text == " ".join(result.sentences)
    assert result.method == "extractive"
    assert result.group_id == group_chunks(source, [[1]] * len(source))[0].id
    assert summarizer.summarize(source, 2) == result


def test_extraction_ties_favor_earlier_sentences():
    # Empty feature vectors give equal zero centrality using the real embedder.
    result = ExtractiveSummarizer(HashEmbedder()).summarize(chunks("!!! ??? ..."), 2)
    assert result.sentences == ["!!!", "???"]


def test_extraction_preserves_korean_numbers_and_internal_spacing():
    source = chunks("가온은  2026년 11월 14일에 12.5%를 받지 않는다. 조건이 맞으면 유지한다.")
    result = ExtractiveSummarizer(HashEmbedder()).summarize(source, 10)
    assert result.sentences == [s for s, _, _ in split_sentences(source[0].text)]
    assert "  2026" in result.text


@pytest.mark.parametrize("limit", [1, 2, 3, 20])
def test_extraction_limit(limit):
    result = ExtractiveSummarizer(HashEmbedder()).summarize(chunks("A. B. C."), limit)
    assert len(result.sentences) == min(limit, 3)


@pytest.mark.parametrize("kind", ["extractive", "model", "fake"])
def test_empty_zero_and_invalid_limits(kind):
    http = FakeHTTP(error=AssertionError("HTTP must not be called"))
    summarizer = {"extractive": ExtractiveSummarizer(HashEmbedder()),
                  "model": OllamaSummarizer("local", http=http),
                  "fake": TruncatingFakeSummarizer()}[kind]
    for source, limit in [([], 3), (chunks(" \n "), 3), (chunks("A sentence."), 0)]:
        result = summarizer.summarize(source, limit)
        assert result.sentences == []
        assert result.text == ""
    for limit in [-1, True, 1.5, "2"]:
        with pytest.raises(ValueError):
            summarizer.summarize([], limit)
    assert http.calls == []


def test_ollama_request_and_sentence_response():
    http = FakeHTTP({"response": "  가온은 12%를 받지 않는다.\n If ready, keep 2026. Third sentence."})
    source = chunks("가온은 12%를 받지 않는다.", "If ready, keep 2026.")
    result = OllamaSummarizer("local-model", "http://localhost:11434/", http).summarize(source, 2)
    url, body = http.calls[0]
    assert url == "http://localhost:11434/api/generate"
    assert set(body) == {"model", "prompt", "stream"}
    assert body["model"] == "local-model"
    assert body["stream"] is False
    assert "at most 2 sentences" in body["prompt"]
    assert "numbers, names, dates, negations and conditional expressions" in body["prompt"]
    assert "숫자·이름·날짜·부정/조건 표현을 바꾸지 말고 보존" in body["prompt"]
    assert "\n\n".join(c.text for c in source) in body["prompt"]
    assert result.sentences == ["가온은 12%를 받지 않는다.", "If ready, keep 2026."]
    assert result.method == "model"
    assert result.text == " ".join(result.sentences)
    assert result.group_id == ExtractiveSummarizer(HashEmbedder()).summarize(source, 2).group_id


def test_ollama_custom_template():
    http = FakeHTTP({"response": "Done."})
    result = OllamaSummarizer("local", http=http, prompt_template="{max_sentences}: {text}").summarize(
        chunks("Synthetic source."), 1)
    assert http.calls[0][1]["prompt"] == "1: Synthetic source."
    assert result.sentences == ["Done."]


@pytest.mark.parametrize("response", [None, [], "text", {}, {"error": "local failure"},
                                       {"response": None}, {"response": 2},
                                       {"response": " \n "}])
def test_ollama_invalid_responses(response):
    with pytest.raises(SummarizerError) as caught:
        OllamaSummarizer("local", http=FakeHTTP(response)).summarize(chunks("Source."), 1)
    assert isinstance(caught.value.__cause__, ValueError)


@pytest.mark.parametrize("error", [ConnectionError("offline"), TimeoutError("local timeout"),
                                    ValueError("invalid JSON"), UnicodeError("invalid text")])
def test_ollama_transport_and_decoding_errors(error):
    with pytest.raises(SummarizerError) as caught:
        OllamaSummarizer("local", http=FakeHTTP(error=error)).summarize(chunks("Source."), 1)
    assert caught.value.__cause__ is error


def test_ollama_invalid_configuration():
    with pytest.raises(ValueError):
        OllamaSummarizer("  ")
    with pytest.raises(SummarizerError):
        OllamaSummarizer("local", http=FakeHTTP(), prompt_template="{missing}").summarize(
            chunks("Source."), 1)


def test_demo_fake_removes_numbers_and_percentages():
    result = TruncatingFakeSummarizer().summarize(chunks(
        "가온은 2026-11-14에 -1,200.50원과 12.5%를 받지 않는다. Keep ９９％ if ready. End."), 2)
    assert len(result.sentences) == 2
    assert not any(c.isdigit() or c in "%％" for c in result.text)
    assert "받지 않는다" in result.text
    assert "if ready" in result.text
    assert result.method == "model"
    assert "데모용 가짜" in TruncatingFakeSummarizer.__doc__

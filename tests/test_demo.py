import json
from pathlib import Path
import re
import socket

import pytest

from prompt_token_saver.demo import create_demo, load_notes
from prompt_token_saver.summarize import OllamaSummarizer
from prompt_token_saver.text import split_sentences


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        pytest.fail("Demo tests must remain offline")

    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)


def test_synthetic_notes():
    notes = load_notes()
    assert set(notes) == {"notes_ko.md", "notes_en.md"}
    for text in notes.values():
        marker, body = text.split("\n", 1)
        assert marker == "synthetic example"
        assert 15 <= len(split_sentences(body)) <= 25
        assert re.search(r"\d{4}-\d{2}-\d{2}", body)
        assert re.search(r"\d+%", body)
    assert all(word in notes["notes_ko.md"] for word in ("정원", "도서실", "공방", "단", "다만"))
    assert all(word in notes["notes_en.md"] for word in ("garden", "library", "workshop", "except"))


def test_demo_completes_offline_and_first_card_retains_source(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    report_path, board_path, failed = create_demo()
    assert report_path == Path("pts-demo/report.json")
    assert board_path == Path("pts-demo/board.html")
    assert failed is False
    report = json.loads(report_path.read_text(encoding="utf-8"))
    first = report["items"][0]
    assert first["demo_arm"] == "TruncatingFakeSummarizer"
    assert first["decision"] == "fallback"
    anchor = next(check for check in first["checks"] if check["name"] == "anchor")
    assert anchor["passed"] is False
    assert anchor["details"]["missing_numbers"]
    assert not re.search(r"\d", first["summary"]["text"])
    assert first["final_text"] == "\n\n".join(chunk["text"] for chunk in first["source_chunks"])
    assert all(number["text"] in first["final_text"]
               for number in anchor["details"]["missing_numbers"])
    extracted = [item for item in report["items"] if item["demo_arm"] == "ExtractiveSummarizer"]
    assert extracted
    assert all(item["summary"]["method"] == "extractive" for item in extracted)
    assert len({item["group_id"] for item in report["items"]}) == len(report["items"])
    board = board_path.read_text(encoding="utf-8")
    assert '<article id="item-0" class="card fallback">' in board
    assert board.index("TruncatingFakeSummarizer") < board.index("ExtractiveSummarizer")
    assert 'class="missing"' in board
    assert report["decision_counts"]["fallback"] >= 1
    assert report["token_counts"]["final"] == sum(
        len(item["final_text"].split()) for item in report["items"])


def test_demo_deterministic_and_overwrites_outputs(tmp_path):
    report_path, board_path, _ = create_demo(tmp_path / "한글 경로")
    before = report_path.read_bytes(), board_path.read_bytes()
    create_demo(report_path.parent)
    assert before == (report_path.read_bytes(), board_path.read_bytes())


def test_demo_output_collision(tmp_path):
    target = tmp_path / "occupied"
    target.write_text("keep", encoding="utf-8")
    with pytest.raises(OSError):
        create_demo(target)
    assert target.read_text(encoding="utf-8") == "keep"


@pytest.mark.parametrize("available", [True, False])
def test_demo_optional_real_adapter_with_injected_http(tmp_path, available):
    calls = []

    class LocalHTTP:
        def post(self, url, json):
            calls.append((url, json))
            if not available:
                raise OSError("Local service absent")
            return {"response": "Invented garden keeps 28 lanterns."}

    model = OllamaSummarizer("qwen3:1.7b", http=LocalHTTP())
    report_path, board_path, failed = create_demo(tmp_path, summarizer=model)
    assert failed is not available
    assert board_path.is_file()
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["items"][0]["demo_arm"] == "TruncatingFakeSummarizer"
    model_items = [item for item in report["items"] if item["demo_arm"] == "OllamaSummarizer"]
    assert model_items and calls
    assert all(call[1]["model"] == "qwen3:1.7b" for call in calls)
    if available:
        assert all(item["summary"]["method"] == "model" for item in model_items)
    else:
        assert len(calls) == 1
        assert all(item["decision"] == "fallback" for item in model_items)
        assert all(item["checks"][0]["details"]["error"] == "summarizer_exception"
                   for item in model_items)

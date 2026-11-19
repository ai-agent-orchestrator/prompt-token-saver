import pytest

from prompt_token_saver import __version__
from prompt_token_saver.cli import main


def test_version(capsys):
    assert main(["--version"]) == 0
    assert capsys.readouterr().out.strip() == f"pts {__version__}"


@pytest.mark.parametrize("argv", [["--help"], []])
def test_help(argv, capsys):
    assert main(argv) == 0
    output = capsys.readouterr().out
    assert all(name in output for name in ("pts", "run", "demo", "board", "--version"))


@pytest.mark.parametrize("command", ["run", "demo", "board"])
def test_bare_command(command, capsys, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    if command == "demo":
        import json

        assert main([command]) == 0
        report_path = tmp_path / "pts-demo" / "report.json"
        board_path = tmp_path / "pts-demo" / "board.html"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        first = report["items"][0]
        assert first["decision"] == "fallback"
        assert first["demo_arm"] == "TruncatingFakeSummarizer"
        assert any(check["name"] == "anchor" and not check["passed"]
                   for check in first["checks"])
        assert first["final_text"] == ""
        assert any(not c["passed"] for c in first["fallback_checks"])
        assert '<article id="item-0" class="card fallback">' in board_path.read_text(
            encoding="utf-8")
        output = capsys.readouterr().out
        assert str(report_path.relative_to(tmp_path)) in output
        assert str(board_path.relative_to(tmp_path)) in output
        assert "B FAIL -> fallback" in output
        return
    assert main([command]) == 2
    assert "아직 없음" in capsys.readouterr().out


def test_invalid_command(capsys):
    assert main(["unknown"]) == 2
    assert "unknown" in capsys.readouterr().err


@pytest.mark.parametrize("command", ["run", "demo", "board"])
def test_command_help(command, capsys):
    assert main([command, "--help"]) == 0
    assert command in capsys.readouterr().out


def test_run_folder(tmp_path, capsys):
    import json

    inputs = tmp_path / "inputs"
    inputs.mkdir()
    (inputs / "first.txt").write_text("synthetic robots count 12 stones.", encoding="utf-8")
    (inputs / "second.md").write_text("synthetic birds visit 7 trees.", encoding="utf-8")
    (inputs / "ignored.csv").write_text("ignored", encoding="utf-8")
    output = tmp_path / "result"
    assert main(["run", str(inputs), "--out", str(output)]) == 0
    report = json.loads((output / "report.json").read_text(encoding="utf-8"))
    assert sum(len(item["source_chunk_ids"]) for item in report["items"]) == 2
    assert report["settings"]["mode"] == "both"
    assert report["token_counts"]["codepoints"]["original"] == sum(len(p.read_text(encoding="utf-8")) for p in inputs.glob("*") if p.suffix in (".txt", ".md"))
    assert "코드포인트" in capsys.readouterr().out


def test_run_multiple_files_and_options(tmp_path):
    import json

    files = [tmp_path / "one.txt", tmp_path / "two.MD"]
    for path in files:
        path.write_text("synthetic example has 3 words.", encoding="utf-8")
    output = tmp_path / "output"
    assert main(["run", *map(str, files), str(files[0]), "--out", str(output),
                 "--mode", "flag", "--weight", "1"]) == 0
    report = json.loads((output / "report.json").read_text(encoding="utf-8"))
    assert report["settings"]["weight"] == 1
    assert report["settings"]["mode"] == "flag"
    assert report["token_counts"]["codepoints"]["original"] == sum(len(p.read_text(encoding="utf-8")) for p in files)


@pytest.mark.parametrize("options", [
    ["--embed", "unknown"], ["--scorer", "unknown"],
    ["--embed", "ollama:"], ["--scorer", "logprob:"],
    ["--weight", "nan"],
])
def test_run_invalid_options(tmp_path, options):
    path = tmp_path / "synthetic.txt"
    path.write_text("synthetic data.", encoding="utf-8")
    assert main(["run", str(path), *options]) == 2


def test_run_missing_or_unsupported_input(tmp_path):
    assert main(["run", str(tmp_path / "missing.txt")]) == 2
    assert main(["run", str(tmp_path)]) == 2


def test_run_invalid_utf8(tmp_path):
    path = tmp_path / "invalid.txt"
    path.write_bytes(b"\xff")
    assert main(["run", str(path)]) == 2


def test_run_explicit_local_models_with_injected_http(tmp_path, monkeypatch):
    import json
    from prompt_token_saver import cli
    from prompt_token_saver.embed import HashEmbedder, OllamaEmbedder
    from prompt_token_saver.summarize import OllamaSummarizer

    source = "synthetic robots count 12 stones."
    calls = []

    class LocalHTTP:
        def post(self, url, json):
            calls.append(url)
            if url.endswith("/api/embed"):
                return {"embeddings": HashEmbedder().embed(json["input"])}
            assert json["model"] == "synthetic-summary"
            return {"response": source}

    http = LocalHTTP()
    monkeypatch.setattr(cli, "OllamaEmbedder", lambda model: OllamaEmbedder(model, http=http))
    monkeypatch.setattr(cli, "OllamaSummarizer", lambda model: OllamaSummarizer(model, http=http))
    path = tmp_path / "synthetic.txt"
    path.write_text(source, encoding="utf-8")
    output = tmp_path / "output"
    assert main(["run", str(path), "--out", str(output), "--model", "synthetic-summary",
                 "--embed", "ollama:synthetic-embedding"]) == 0
    report = json.loads((output / "report.json").read_text(encoding="utf-8"))
    assert report["settings"]["embedder_id"] == "synthetic-embedding"
    assert report["items"][0]["summary"]["method"] == "model"
    assert report["items"][0]["decision"] == "pass"
    assert [url.rsplit("/", 1)[-1] for url in calls] == ["embed", "generate"]


def test_run_board_and_standalone_board(tmp_path, capsys):
    import json

    source = tmp_path / "synthetic.txt"
    source.write_text("synthetic robots record 42 samples.", encoding="utf-8")
    output = tmp_path / "result"
    assert main(["run", str(source), "--out", str(output), "--board"]) == 0
    board = (output / "board.html").read_text(encoding="utf-8")
    report = json.loads((output / "report.json").read_text(encoding="utf-8"))
    item, = report["items"]
    assert item["source_chunks"][0]["text"] == source.read_text(encoding="utf-8")
    assert any(anchor["text"] == "42" for anchor in item["anchors"])
    assert 'class="retained"' in board
    another = tmp_path / "review" / "index.html"
    assert main(["board", str(output / "report.json"), "--out", str(another)]) == 0
    assert another.read_text(encoding="utf-8") == board
    assert str(another) in capsys.readouterr().out


def test_board_default_output_and_open(tmp_path, monkeypatch):
    from prompt_token_saver import cli

    source = tmp_path / "synthetic.txt"
    source.write_text("synthetic robots record 42 samples.", encoding="utf-8")
    assert main(["run", str(source), "--out", str(tmp_path)]) == 0
    assert not (tmp_path / "board.html").exists()
    monkeypatch.chdir(tmp_path)
    opened = []
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    assert main(["board", str(tmp_path / "report.json"), "--open"]) == 0
    assert (tmp_path / "board.html").is_file()
    assert opened == [(tmp_path / "board.html").as_uri()]


@pytest.mark.parametrize("content", [None, "invalid", "[]", '{"items": [{}]}'])
def test_board_invalid_input(tmp_path, content, capsys):
    report = tmp_path / "report.json"
    if content is not None:
        report.write_text(content, encoding="utf-8")
    output = tmp_path / "board.html"
    assert main(["board", str(report), "--out", str(output)]) == 2
    assert "pts board:" in capsys.readouterr().out
    assert not output.exists()


def test_board_keeps_actual_scorer_output_without_rescoring(tmp_path, monkeypatch):
    from prompt_token_saver.surprise import IdfScorer

    calls = []
    score = IdfScorer.score

    def record(self, text):
        calls.append(text)
        return score(self, text)

    monkeypatch.setattr(IdfScorer, "score", record)
    source = tmp_path / "synthetic.txt"
    source.write_text("synthetic robots record 42 samples.", encoding="utf-8")
    assert main(["run", str(source), "--out", str(tmp_path), "--board"]) == 0
    assert calls == [source.read_text(encoding="utf-8")]


def test_demo_default_output_and_open(tmp_path, monkeypatch, capsys):
    from prompt_token_saver import cli
    from prompt_token_saver.embed import _UrllibHTTP

    def blocked(*args, **kwargs):
        pytest.fail("Default demo must not contact a model")

    monkeypatch.setattr(_UrllibHTTP, "post", blocked)
    monkeypatch.chdir(tmp_path)
    opened = []
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    assert main(["demo", "--open"]) == 0
    assert (tmp_path / "pts-demo" / "report.json").is_file()
    board = tmp_path / "pts-demo" / "board.html"
    assert board.is_file()
    assert opened == [board.as_uri()]
    output = capsys.readouterr().out
    assert "report.json" in output and "board.html" in output
    assert "B FAIL -> fallback" in output


def test_demo_explicit_output_without_open(tmp_path, monkeypatch):
    from prompt_token_saver import cli

    def blocked(*args, **kwargs):
        pytest.fail("Browser must open only with --open")

    monkeypatch.setattr(cli.webbrowser, "open", blocked)
    assert main(["demo", "--out", str(tmp_path / "custom")]) == 0
    assert (tmp_path / "custom" / "board.html").is_file()


def test_demo_output_failure(tmp_path, capsys):
    target = tmp_path / "occupied"
    target.write_text("keep", encoding="utf-8")
    assert main(["demo", "--out", str(target)]) == 2
    assert "pts demo:" in capsys.readouterr().out


def test_demo_unavailable_local_model(tmp_path, monkeypatch, capsys):
    from prompt_token_saver import cli
    from prompt_token_saver.summarize import OllamaSummarizer

    class LocalHTTP:
        def post(self, url, json):
            raise OSError("Local service absent")

    monkeypatch.setattr(cli, "OllamaSummarizer",
                        lambda model: OllamaSummarizer(model, http=LocalHTTP()))
    assert main(["demo", "--model", "qwen3:1.7b", "--out", str(tmp_path)]) == 0
    assert "Local Ollama model unavailable" in capsys.readouterr().out
    assert (tmp_path / "board.html").is_file()


def test_demo_empty_model(tmp_path):
    assert main(["demo", "--model", "", "--out", str(tmp_path)]) == 2
    assert not (tmp_path / "report.json").exists()


def test_quickstart_commands_match_help(capsys):
    from pathlib import Path
    import re

    quickstart = (Path(__file__).resolve().parents[1] / "docs" / "QUICKSTART.md").read_text(
        encoding="utf-8")
    commands = re.findall(r"^pts (\w+)(.*)$", quickstart, re.MULTILINE)
    assert commands
    assert main(["--help"]) == 0
    root_help = capsys.readouterr().out
    for command, arguments in commands:
        assert command in root_help
        assert main([command, "--help"]) == 0
        help_text = capsys.readouterr().out
        for option in re.findall(r"--[\w-]+", arguments):
            assert option in help_text

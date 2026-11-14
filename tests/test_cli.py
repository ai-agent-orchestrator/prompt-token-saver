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
def test_unimplemented(command, capsys):
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
    assert report["token_counts"]["original"] == 10
    assert "근사" in capsys.readouterr().out


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
    assert report["token_counts"]["original"] == 10


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

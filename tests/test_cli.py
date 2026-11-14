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

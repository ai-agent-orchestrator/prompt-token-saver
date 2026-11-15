"""Check bundled data declarations without building or downloading packages."""

import ast
from fnmatch import fnmatchcase
from pathlib import Path
import re

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 has no standard-library TOML parser.
    tomllib = None


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "prompt_token_saver"


def package_data_patterns():
    text = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    if tomllib is not None:
        return tomllib.loads(text)["tool"]["setuptools"]["package-data"][
            "prompt_token_saver"
        ]
    section = re.search(
        r"(?ms)^\[tool\.setuptools\.package-data\]\s*\n(.*?)(?=^\[|\Z)",
        text,
    )
    assert section is not None, "Missing setuptools package-data section"
    entry = re.search(
        r'(?ms)^prompt_token_saver\s*=\s*(\[[^\]]*\])', section.group(1)
    )
    assert entry is not None, "Missing prompt_token_saver package-data entry"
    return ast.literal_eval(entry.group(1))


def test_demo_markdown_is_declared_as_package_data():
    assert "demo/*.md" in package_data_patterns()


def test_all_non_python_package_files_are_declared():
    patterns = package_data_patterns()
    uncovered = []
    for path in PACKAGE.rglob("*"):
        relative = path.relative_to(PACKAGE)
        if not path.is_file() or "__pycache__" in relative.parts:
            continue
        if path.suffix == ".py":
            continue
        name = relative.as_posix()
        if not any(fnmatchcase(name, pattern) for pattern in patterns):
            uncovered.append(name)
    assert not uncovered, f"Files missing from package-data: {sorted(uncovered)}"

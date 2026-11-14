"""Shared records used throughout the prompt processing pipeline."""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Chunk:
    id: str
    doc_id: str
    text: str
    start: int
    end: int


@dataclass(frozen=True)
class Group:
    id: str
    chunk_ids: list[str]


@dataclass(frozen=True)
class Summary:
    group_id: str
    text: str
    sentences: list[str]
    method: Literal["model", "extractive"]


@dataclass(frozen=True)
class CheckResult:
    name: str
    passed: bool
    score: float
    details: dict


@dataclass(frozen=True)
class ItemResult:
    group_id: str
    source_chunk_ids: list[str]
    summary: Summary
    checks: list[CheckResult]
    decision: Literal["pass", "fallback", "flag"]
    final_text: str

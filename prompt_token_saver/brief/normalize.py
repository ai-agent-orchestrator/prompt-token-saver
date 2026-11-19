"""Shared, packaged constants and Unicode codepoint normalization."""
import hashlib
import json
from pathlib import Path
C = json.loads(Path(__file__).with_name("constants.json").read_text(encoding="utf-8"))
def normalize(text):
    return text.replace("\r\n", "\n").replace("\r", "\n")
def budget_for(text):
    return len(text) // C["BUDGET_DIV"]
def source_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
def grams(text, n=3):
    import re
    chars = re.sub(r"\s+", " ", text.lower()).strip()
    return {chars} if 0 < len(chars) < n else {chars[i:i+n] for i in range(len(chars)-n+1)}
def containment(a, b):
    return len(a & b) / len(a) if a else 0

def markers(text, values):
    return [v for v in values if v in text.lower()]

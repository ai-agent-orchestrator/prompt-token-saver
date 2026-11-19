"""Shared sentence boundaries; offsets are Unicode codepoints."""
import re
from .normalize import C
BOUNDARY = re.compile(r"""[.?!。]+["'”’」』)]*(?=\s|$)|\n""")
ABBREVIATION = re.compile(r"(?:\b(?:[A-Za-z]\.){2,}|\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc)\.)$", re.I)
def split_sentences(text):
    result, start = [], 0
    def append(end):
        raw = text[start:end]
        left = len(raw)-len(raw.lstrip())
        value = raw.strip()
        if value:
            result.append({"text": value, "start": start+left, "end": start+left+len(value)})
    for match in BOUNDARY.finditer(text):
        if match[0].startswith(".") and ABBREVIATION.search(text[:match.start()+1]):
            continue
        append(match.start() if match[0] == "\n" else match.end())
        start = match.end()
    append(len(text))
    return result

def segment(text):
    lines, result, offset, title, section, first = text.split("\n"), [], 0, "", 0, True
    for i, raw in enumerate(lines):
        trimmed = raw.strip()
        heading = bool(re.match(r"^#{1,6}\s+", trimmed) or (trimmed and len(trimmed) <= C["HEADING_MAX_CP"] and not re.search(r"[.?!。]$", trimmed) and i+1 < len(lines) and lines[i+1] == "" and not re.match(r"^[-*•]|^\d+[.)]\s", trimmed)))
        if heading:
            title, section, first = re.sub(r"^#{1,6}\s+", "", trimmed), section+1, True
        else:
            prefix = re.match(r"^\s*(?:[-*•]\s+|\d+[.)]\s+)", raw)
            prefix = prefix[0] if prefix else ""
            for part in split_sentences(raw[len(prefix):]):
                result.append({"id": f"s{len(result)+1}", "text": part["text"], "span": [offset+len(prefix)+part["start"], offset+len(prefix)+part["end"]], "title": title, "section": section, "first": first, "order": len(result)})
                first = False
        offset += len(raw)+1
    return result

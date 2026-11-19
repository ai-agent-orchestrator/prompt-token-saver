"""Render a self-contained, offline review board from a pipeline report."""

import hashlib
from html import escape
import json
import math
from pathlib import Path


def wilson_interval(passed: int, total: int) -> tuple[float, float]:
    """Wilson score interval at 95%; no observations have interval [0, 1]."""
    if not 0 <= passed <= total:
        raise ValueError("Expected 0 <= passed <= total")
    if not total:
        return 0.0, 1.0
    z = 1.959963984540054
    p = passed / total
    denominator = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    radius = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total**2)) / denominator
    return max(0.0, center - radius), min(1.0, center + radius)


def _highlight(text, spans):
    """Escape all text and mark only validated original character offsets."""
    result, cursor = [], 0
    for start, end, kind in sorted(spans):
        if not cursor <= start < end <= len(text):
            continue
        result.extend((escape(text[cursor:start]),
                       f'<mark class="{kind}" data-start="{start}" data-end="{end}">',
                       escape(text[start:end]), '</mark>'))
        cursor = end
    result.append(escape(text[cursor:]))
    return ''.join(result)


def _source(item, anchor_details):
    chunks = item.get("source_chunks", [])
    if not chunks:
        return '<p class="muted">이 보고서에는 원문 청크가 없습니다.</p>'
    missing = {(a["start"], a["end"]) for a in anchor_details.get("missing", [])}
    changed = {(a["anchor"]["start"], a["anchor"]["end"])
               for a in anchor_details.get("changed", [])}
    anchors = item.get("anchors", []) + anchor_details.get("missing", [])
    result, offset = [], 0
    for chunk in chunks:
        text = chunk["text"]
        spans = {}
        for anchor in anchors:
            start, end = anchor["start"] - offset, anchor["end"] - offset
            if 0 <= start < end <= len(text) and text[start:end] == anchor["text"]:
                position = (anchor["start"], anchor["end"])
                spans[start, end] = ("changed" if position in changed else
                                     "missing" if position in missing else "retained")
        result.append(f'<h4>{escape(chunk["id"])}</h4><pre class="source">'
                      + _highlight(text, [(a, b, kind) for (a, b), kind in spans.items()])
                      + '</pre>')
        offset += len(text) + 2  # The pipeline joins group chunks with two newlines.
    return ''.join(result)


def _summary(item, meaning_details):
    text = item["summary"]["text"]
    spans = []
    for sentence in meaning_details.get("unsupported_sentences", []):
        if not sentence:
            continue
        start = text.find(sentence)
        while start != -1:
            spans.append((start, start + len(sentence), "unsupported"))
            start = text.find(sentence, start + len(sentence))
    return _highlight(text, spans)


def render(report_json_path, out_html_path):
    """Write one UTF-8 HTML file. Never read source paths from a report."""
    raw = Path(report_json_path).read_text(encoding="utf-8")
    report = json.loads(raw)
    if isinstance(report, dict) and report.get("schema") == "pts.summary/v1":
        return render_brief(report, out_html_path)
    if not isinstance(report, dict) or not isinstance(report.get("items"), list):
        raise ValueError("Report must contain an items list")
    items, settings = report["items"], report.get("settings", {})
    if not isinstance(settings, dict):
        raise ValueError("Report settings must be an object")
    mode, weight = settings.get("mode", "both"), settings.get("weight", 0.5)
    if mode not in ("meaning", "anchor", "both", "flag"):
        raise ValueError("Unknown mode")
    if not isinstance(weight, (int, float)) or not math.isfinite(weight) or not 0 <= weight <= 1:
        raise ValueError("weight must be finite and in [0, 1]")
    counts = {name: sum(item["decision"] == name for item in items)
              for name in ("pass", "fallback", "flag")}
    low, high = wilson_interval(counts["pass"], len(items))
    rate = counts["pass"] / len(items) if items else 0
    cards, preview = [], []
    for index, item in enumerate(items):
        checks = {check["name"]: check for check in item["checks"]}
        a, b = checks.get("meaning"), checks.get("anchor")
        badges = ''.join(f'<span class="badge {"pass" if check["passed"] else "fallback"}">'
                         f'검사 {label}: {"PASS" if check["passed"] else "FAIL"} '
                         f'({check["score"]:.3f})</span>' if check else
                         f'<span class="badge">검사 {label}: 없음</span>'
                         for label, check in (("A", a), ("B", b)))
        cards.append(f'''<article id="item-{index}" class="card {escape(item['decision'])}">
<h2>{escape(item['group_id'])}</h2><div>{badges}
<strong class="decision">{escape(item['decision'])}</strong>
<span class="score">{item.get('final_score', 0):.3f}</span></div>
<div class="columns"><section><h3>원문 청크</h3>{_source(item, b['details'] if b else {})}</section>
<section><h3>모델 요약 · {escape(item['summary']['method'])}</h3>
<pre>{_summary(item, a['details'] if a else {})}</pre><h3>최종 텍스트 (원래 실행)</h3>
<pre>{escape(item['final_text'])}</pre></section></div>
<div class="labels"><button data-index="{index}" data-correct="true" aria-pressed="false">판정 맞음</button>
<button data-index="{index}" data-correct="false" aria-pressed="false">판정 틀림</button></div></article>''')
        preview.append({"group_id": item["group_id"], "original_decision": item["decision"],
                        "a": a, "b": b,
                        "forced": any(c["name"] == "summarizer" and not c["passed"]
                                      for c in item["checks"])})
    identity = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    payload = json.dumps({"items": preview, "mode": mode, "weight": weight,
                          "identity": identity}, ensure_ascii=True, allow_nan=False)
    # Script data is raw text in HTML: HTML entities alone cannot protect it.
    payload = payload.replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    options = ''.join(f'<option value="{value}"{" selected" if value == mode else ""}>{value}</option>'
                      for value in ("meaning", "anchor", "both", "flag"))
    html = f'''<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>PTS 판정 보드</title>
<style>{_CSS}</style></head><body><header><h1>PTS 판정 보드</h1>
<p>원래 실행: pass {counts['pass']} · fallback {counts['fallback']} · flag {counts['flag']}</p>
<p>통과율 {rate:.1%} · Wilson 95% 구간 {low:.2%}–{high:.2%}
 · 근사 토큰 절감률 {report.get('savings_rate', 0):.1%}</p>
<p>설정: mode {mode} · w {weight:g} · 문턱 버전 {escape(str(settings.get('threshold_version', '없음')))}</p>
<label>mode <select id="mode">{options}</select></label>
<label>w <input id="weight" type="range" min="0" max="1" step="0.01" value="{weight}">
<output id="weight-value">{weight:g}</output></label>
<p class="muted">미리보기: w는 합산 점수를 바꾸고 mode는 검사 통과 여부로 판정합니다.
최종 텍스트와 위 통계는 원래 실행입니다. 라벨은 표시된 판정에 연결됩니다.</p>
<p id="preview-counts" aria-live="polite"></p><p id="label-counts" aria-live="polite"></p>
<button id="export">라벨 내보내기</button><p id="storage-status" role="status"></p>
</header><main>{''.join(cards) if cards else '<p>항목이 없습니다.</p>'}</main>
<script id="board-data" type="application/json">{payload}</script><script>{_JS}</script></body></html>'''
    output = Path(out_html_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html, encoding="utf-8")


_CSS = '''
:root{color-scheme:dark;background:#0e141b;color:#e6edf6;font:16px system-ui,sans-serif}
body{max-width:1280px;margin:auto;padding:24px}header,.card{background:#131c27;border:1px solid #24324a;border-radius:12px;padding:24px;margin-bottom:20px}
h1,h2,h3,h4{overflow-wrap:anywhere}h1{color:#78d5ef}h2{font-size:1.15rem}h3{color:#5ba7db}h4{font-size:.8rem;font-weight:normal;color:#aab8ca}
.columns{display:grid;grid-template-columns:1fr 1fr;gap:24px}.columns>section{min-width:0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.7}
mark{background:transparent}.retained{color:#4cc3a8}.missing{color:#c58b92;text-decoration:underline;text-decoration-thickness:2px}.changed{color:#f0cf78;background:#514326}.unsupported{color:#c58b92;background:#38232d}
.badge,.decision,.score{display:inline-block;border:1px solid #24324a;border-radius:6px;padding:5px 9px;margin:3px}
.pass .decision,.badge.pass{color:#4cc3a8}.fallback .decision,.badge.fallback{color:#c58b92}.flag .decision{color:#f0cf78}
.card.pass{border-left:4px solid #4cc3a8}.card.fallback{border-left:4px solid #c58b92}.card.flag{border-left:4px solid #f0cf78}
button,select{background:#0e141b;color:#e6edf6;border:1px solid #5ba7db;border-radius:6px;padding:9px;margin:4px;cursor:pointer}
button[aria-pressed=true]{background:#24324a;outline:2px solid #4cc3a8}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #78d5ef}
label{display:inline-flex;align-items:center;gap:8px;margin-right:20px}.muted{color:#aab8ca;font-size:.9rem}
@media(max-width:760px){body{padding:10px}.columns{grid-template-columns:1fr}header,.card{padding:16px}}
'''


_JS = '''
"use strict";
const data = JSON.parse(document.getElementById("board-data").textContent);
const mode = document.getElementById("mode"), weight = document.getElementById("weight");
const storageKey = "pts-board-v1:" + data.identity;
let labels = Object.create(null);
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    data.items.forEach((item, i) => {
      const entry = saved[i];
      if (entry && typeof entry.correct === "boolean" &&
          ["pass", "fallback", "flag"].includes(entry.decision)) labels[i] = entry;
    });
  }
} catch (_) { document.getElementById("storage-status").textContent = "브라우저 저장소를 사용할 수 없습니다. 라벨을 내보내 주세요."; }
function evaluate(item, selectedMode, w) {
  const a = item.a, b = item.b;
  const score = (1 - w) * (a ? a.score : 0) + w * (b ? b.score : 0);
  if (item.forced || !a || !b) return {decision: "fallback", score: 0};
  const passed = selectedMode === "meaning" ? a.passed :
    selectedMode === "anchor" ? b.passed : a.passed && b.passed;
  return {decision: passed ? "pass" : selectedMode === "flag" ? "flag" : "fallback", score};
}
function refresh() {
  const counts = {pass: 0, fallback: 0, flag: 0};
  let falsePass = 0, falseReject = 0, reviewed = 0, flags = 0;
  document.getElementById("weight-value").textContent = Number(weight.value).toFixed(2);
  data.items.forEach((item, i) => {
    const result = evaluate(item, mode.value, Number(weight.value));
    const card = document.getElementById("item-" + i);
    card.className = "card " + result.decision;
    card.querySelector(".decision").textContent = result.decision;
    card.querySelector(".score").textContent = result.score.toFixed(3);
    counts[result.decision]++;
    const entry = labels[i];
    const active = entry && entry.decision === result.decision;
    if (active) {
      reviewed++;
      if (!entry.correct) {
        if (result.decision === "pass") falsePass++;
        else if (result.decision === "fallback") falseReject++;
        else flags++;
      }
    }
    card.querySelectorAll("button[data-correct]").forEach(button => {
      button.setAttribute("aria-pressed", String(Boolean(active && entry.correct === (button.dataset.correct === "true"))));
    });
  });
  document.getElementById("preview-counts").textContent = `미리보기: pass ${counts.pass} · fallback ${counts.fallback} · flag ${counts.flag}`;
  document.getElementById("label-counts").textContent = `표시 ${reviewed} · 잘못 통과 ${falsePass} · 잘못 거부 ${falseReject} · 잘못 flag ${flags}`;
}
document.querySelectorAll("button[data-correct]").forEach(button => {
  button.addEventListener("click", () => {
    const i = Number(button.dataset.index);
    const result = evaluate(data.items[i], mode.value, Number(weight.value));
    labels[i] = {correct: button.dataset.correct === "true", decision: result.decision,
                 mode: mode.value, weight: Number(weight.value)};
    try { localStorage.setItem(storageKey, JSON.stringify(labels)); }
    catch (_) { document.getElementById("storage-status").textContent = "저장하지 못했습니다. 라벨을 내보내 주세요."; }
    refresh();
  });
});
mode.addEventListener("change", refresh);
weight.addEventListener("input", refresh);
document.getElementById("export").addEventListener("click", () => {
  const records = Object.entries(labels).map(([i, entry]) => ({
    index: Number(i), group_id: data.items[i].group_id,
    original_decision: data.items[i].original_decision, ...entry
  }));
  const blob = new Blob([JSON.stringify({report_id: data.identity, labels: records}, null, 2)],
                        {type: "application/json;charset=utf-8"});
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = "pts-labels.json";
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
refresh();
'''


def render_brief(result, out_html_path):
    """Render the separate brief audit report, never treating it as body."""
    from .brief import assert_result
    assert_result(result)
    report = result["report"]
    rows = []
    for group in report["groups"]:
        candidates = []
        for attempt in group["attempts"]:
            checks = " · ".join(f"{escape(name)}: {escape(str(check.get('result')))} / {escape(str(check.get('reason') or ''))}" for name, check in attempt["checks"].items())
            candidates.append(f"<details><summary>{escape(attempt['method'])} / {escape(attempt['decision'])}</summary><pre>{escape(attempt['candidate'])}</pre><p>{checks}</p></details>")
        rows.append(f"<tr><td>{escape(group['title'])}<br>{group['weight']:.3f} / {group['budget']}자</td><td>{''.join(candidates)}</td><td>{escape(group['status'])}</td></tr>")
    omitted = "".join(f"<li>{escape(a['sentenceId'])}: {escape(a['text'])} ({escape(a['reason'])})</li>" for a in report["omittedAnchors"])
    data = json.dumps(report, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    html = f"""<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Brief 판정 보드</title>
<style>body{{background:#08111c;color:#dfefff;font:16px system-ui;margin:24px}}main{{max-width:1200px;margin:auto}}table{{width:100%;border-collapse:collapse}}td,th{{padding:14px;border:1px solid #32b5ff;text-align:left;vertical-align:top}}pre{{white-space:pre-wrap;overflow-wrap:anywhere}}details{{padding:10px}}input{{min-height:44px}}</style><main>
<h1>Brief 판정 보드</h1><p>{escape(result['status'])} · {result['metrics']['bodyCodepoints']}자 / 상한 {result['metrics']['budget']}자</p><pre>{escape(result['body'])}</pre>
<p>{escape(report['engine']['version'])} · {escape(report['engine']['constantsVersion'])} · 모델 {escape(str(report['engine']['generatorId']))} · 임계값 보정 전</p>
<label>미리보기 문턱값 <input id="threshold" type="range" min="0" max="1" step="0.01" value="0.75"></label><p id="preview">저장된 후보만 재판정합니다. 본문은 바뀌지 않습니다. 실제 재실행: pts brief FILE --json</p>
<table><thead><tr><th>주제 / 가중치 / 예산</th><th>후보와 검사 A·B·C</th><th>최종 상태</th></tr></thead><tbody>{''.join(rows)}</tbody></table><details><summary>누락 앵커 {len(report['omittedAnchors'])}개 · 누락 그룹 {len(report['omittedGroups'])}개</summary><ul>{omitted}</ul></details>
<script type="application/json" id="audit">{data}</script>
<script>const report=JSON.parse(document.getElementById('audit').textContent);document.getElementById('threshold').addEventListener('input',event=>{{let total=0,pass=0;for(const g of report.groups)for(const a of g.attempts){{if(a.decision==='error')continue;total++;const m=a.checks.meaning;const valid=(!m.reason||m.reason==='LOW_CONTAINMENT')&&m.matches.length&&m.matches.every(x=>x.score>=Number(event.target.value));if(valid&&a.checks.anchor.result==='PASS'&&a.checks.length.result==='PASS')pass++;}}document.getElementById('preview').textContent=`미리보기(본문 변경 없음): ${{total}}개 후보 중 ${{pass}}개 통과. 실제 재실행: pts brief FILE --json`;}});</script></main></html>"""
    path = Path(out_html_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(html, encoding="utf-8")
    return path

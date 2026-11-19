# Brief API

## 브라우저

```js
import { summarize, refine } from '../apps/tablet/src/core/summary/engine.js';
const first = await summarize(source, { generator: null, keepTerms: [], signal });
const second = await refine(first, { text: source, generator: null, signal });
```

`generator.generate({prompt, maxOutputTokens, maxChars, signal})`은 문자열을 반환합니다. 모델 후보 2회(2차는 1회), 오류 시 재검사한 압축 발췌를 사용합니다. 본문은 result.body이고 상태가 OK가 아니면 빈 문자열입니다. report에는 원문 발췌·후보가 있으므로 선택적 진단 자료로 취급하세요.

## Python

```python
from prompt_token_saver import summarize_brief
first = summarize_brief(source)
second = summarize_brief(source, stage1=first)
```

`generator.generate(prompt: str, max_chars: int) -> str` 프로토콜을 지원합니다. `OllamaSummarizer(model)` 어댑터를 주입할 수 있습니다. keep_terms, threading.Event 형태 signal, 모델 제한 대기 model_timeout_ms를 지원합니다.

```sh
pts brief FILE
pts brief FILE --stage2
pts brief FILE --model LOCAL_MODEL --json
pts board report.json --out board.html
```

기본 stdout은 성공한 본문만, 실패는 stderr와 종료 코드 2입니다. --json은 전체 계약 결과를 출력합니다.

[전체 계약](../spec/summary-contract.md) · [공유 fixture](../spec/fixtures/)

## 기존 호환 API

compress(), compressed_text(), summary_line(), pts run은 남아 있으나 전역 글자 예산이 없습니다. 새 브라우저 앱은 호출하지 않습니다. fallback도 재검사하며 실패한 대체 본문은 출력에서 제외합니다. token_counts는 {codepoints:{original,final},tokens:null}로 명확히 구분하고 summary_line은 글자 수를 표시합니다. 기본 의미 검사는 유사도 기반이며 사실 검증을 보증하지 않습니다.

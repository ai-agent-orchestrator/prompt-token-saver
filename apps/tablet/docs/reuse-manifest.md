# 재사용·출처 기록 — 태블릿 첫 구현

확인일: 2026-11-18 KST. 이 문서는 실행 코드와 설계 참고를 구분한다. 실모델 품질·기기별 성능의 검증 기록은 아니다.

## 1. 실제 포함한 런타임

| 구성요소 | 고정 버전·출처 | 포함 방법 | 라이선스·고지 |
|---|---|---|---|
| `@litert-lm/core` | npm `0.19.0`, `package-lock.json`의 integrity, [Google LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) | npm의 JS와 `wasm/` 자산. 새 Worker 어댑터가 `Engine.create`·`createConversation`·streaming·`cancel`·`delete`를 호출 | Apache-2.0. 전체 약관을 `runtime/LICENSE-litert-lm-core.txt`, 저작권·출처를 `runtime/NOTICE.txt`로 배포 |
| `@litertjs/wasm-utils` | 설치된 `2.6.0`, lockfile, [Google LiteRT의 wasm_utils](https://github.com/google-ai-edge/LiteRT/tree/main/litert/js/packages/wasm_utils) | SDK가 사용하는 JS loader. `importScripts()`를 사용하므로 SDK를 classic IIFE Worker로 묶어 실행 | Apache-2.0. 전체 약관을 `runtime/LICENSE-litertjs-wasm-utils.txt`로 배포 |
| 사용자 모델 | 사용자가 직접 선택한 Web 호환 `.litertlm` | 브라우저의 File/Blob을 SDK에 전달. 모델 가중치는 Git·배포물에 포함하지 않음 | 모델별 조건을 사용자가 확인. 앱의 Apache 고지가 모델 라이선스를 대신하지 않음 |

설치된 두 npm tarball에는 별도 LICENSE 파일이 없다. [보관한 Apache-2.0 전체 약관](../licenses/Apache-2.0.txt)을 빌드 시 복사하며, 이후 패키지에 원본 LICENSE가 포함되면 그 파일을 그대로 보존한다. `runtime/manifest.json`은 실제 package version, 각 런타임 파일의 bytes·SHA-256, 약관 파일과 그 출처를 기록한다. SDK upstream 소스를 직접 수정하지 않았고, 새 어댑터를 묶는 빌드 변환만 한다.

모든 호환 WASM variant를 배포하지만, 모델 사용 전에 앱이 전부 다운로드하지 않는다. SDK가 해당 브라우저의 variant를 선택한다. Core/Lite 전송 크기와 SDK runtime·모델 크기는 별도다. 실제 모델 SHA-256은 아직 측정하지 않으므로 `null`이며, 파일명이나 크기를 해시라고 부르지 않는다.

구현: [generator.js](../src/model/generator.js), [inference.worker.js](../src/model/inference.worker.js), [copy-runtime.mjs](../scripts/copy-runtime.mjs).

## 2. prompt-token-saver 조사 기준

- 저장소: [ai-agent-orchestrator/prompt-token-saver](https://github.com/ai-agent-orchestrator/prompt-token-saver)
- 확인한 고정 커밋: `1ff74ec875d015e90f4c6f283a7a6b6206c70666`
- 패키지: Python `prompt-token-saver` `0.1.0`, Python 3.10 이상. 기본 의존성 없음, Chroma/transformers·torch는 선택 의존성이다.
- 라이선스: [MIT 원본](https://github.com/ai-agent-orchestrator/prompt-token-saver/blob/1ff74ec875d015e90f4c6f283a7a6b6206c70666/LICENSE), Copyright (c) 2026 ai-agent-orchestrator.
- **이번 앱은 upstream Python 코드를 실행·복사·직접 이식하지 않는다. API 호환판이나 같은 엔진의 실측 동등판이라고 주장하지 않는다.** 브라우저 알고리즘과 합성 시험은 새로 작성했다.

upstream의 공개 진입점은 `compress(docs, mode, weight, max_sentences, group_threshold, embedder, store, summarizer, scorer, meaning_rule) -> RunReport`다. `compressed_text(report)`는 각 `final_text`를 연결한다. `RunReport`는 `items`, `settings`, 근사 `token_counts`, `savings_rate`, `decision_counts`를 가지며, 각 결과는 후보 `summary`·`checks`·`decision(pass|fallback|flag)`·실제 전달 `final_text`를 분리한다.

## 3. 참고한 계약과 현재 구현의 차이

| upstream 고정 커밋의 경로 | 조사한 동작 | 이번 브라우저 구현 | 동일 구현 여부 |
|---|---|---|---|
| `prompt_token_saver/api.py`, `pipeline.py` | 부품 주입, 묶기→요약→검사, 후보와 최종 출력 분리 | [research.js](../src/core/research.js)의 `analyzeResearch`와 별도 `BrowserGenerator`, 카드별 검사·실패 표시 | 구조적 설계 참고. Python `compress`를 호출하지 않고 `RunReport`와도 다른 앱 스키마 사용 |
| `types.py`, `text.py` | 원문 `Chunk.start/end` 좌표, 원문 문장 보존 | 코드포인트 span과 별도 UTF-16 변환, Google 탭/segment 좌표 연결 | 보존 계약 참고. 문장 분할은 `Intl.Segmenter` 기반이므로 Python 정규식과 결과가 같다고 보장하지 않음 |
| `group.py`, `embed.py` | 임베딩 코사인 기반 average-link 군집화 | 제목·일반 단어 겹침으로 맥락 후보를 묶음 | 새 단순 알고리즘. 벡터 의미 군집화·Chroma·검색은 이번 구현에 없음 |
| `summarize.py`의 `ExtractiveSummarizer` | 문장 임베딩의 평균 코사인으로 순위, 입력 순서로 복원 | 보호할 수치/조건·경계 사실과 단어 빈도로 문장 선택 | 새 알고리즘. upstream 추출 요약기와의 parity 검증 없음 |
| `summarize.py`의 `OllamaSummarizer` | 주입한 로컬 모델이 요약 후보 생성 | LiteRT-LM이 원문 fact ID를 선택하고 원문 문장을 그대로 렌더링 | 새 생성 계약. 첫 구현은 **AI 근거 선택 + 원문 발췌**이며 자유로운 의역 요약을 제공하지 않음 |
| `check_anchor.py`, `surprise.py` | 정규화 앵커·문맥 속 숫자 변조, IDF/logprob scorer | 수치·부정/조건·사용자 keep terms가 있는 문장 자체를 보호, 모델의 알려진 fact ID만 채택 | 안전 요구 참고. upstream 앵커 검사기/IDF를 이식하지 않음. 실제 surprisal·logprob 미측정 |
| `check_meaning.py` | 문장/근거 벡터와 버전 있는 GapRule로 의미 검사 | `semanticStatus=UNAVAILABLE`, `basis=rules_only` | 미구현. 키워드 겹침을 의미 검증 성공으로 표시하지 않음 |
| `pipeline.py`의 token_counts | 공백 분리 근사 토큰 | 코드포인트·1,500자 기준 쪽수, `tokens=null` | 다른 분량 기준. tokenizer가 고정되기 전 토큰 절감률을 실측 수치로 주장하지 않음 |
| `tests/` | Python 공개 엔진 계약 사례 | [앱 tests](../tests)의 새 합성 자료·가짜 모델·가짜 Google 시험 | upstream fixture를 복사하거나 공통 기대값으로 parity를 확인한 것은 아님 |

확인한 upstream 소스는 위 커밋의 [파일 목록](https://github.com/ai-agent-orchestrator/prompt-token-saver/tree/1ff74ec875d015e90f4c6f283a7a6b6206c70666/prompt_token_saver)이다. 이번 앱 배포에는 upstream Python 패키지·소스·모델이 포함되지 않는다. 향후 코드나 fixture를 가져오면 해당 원본 경로·커밋·수정 사항과 MIT 저작권/허가 고지를 함께 추가해야 한다.

## 4. 제품 저장소에서 이어받은 계약

| 기존 명세 | 이어받은 요구 | 브라우저에서 새로 구현한 부분 |
|---|---|---|
| LB-02 | 선택 문서 읽기, 입력 보호, 새 산출물 저장 | GIS token client·Picker·`drive.file`, 모든 탭 추출, 원문 mutation 차단, 저장 장부 |
| LB-03 | 외부 문자열의 outbound 마스킹 경계 | 정규식과 사용자 직접 입력 단어. 사전·복원 매핑은 공유하지 않음 |
| LB-04~06 | 입력 불변판·좌표·사실/앵커 보존 | SHA-256 스냅샷, 사실·처리 장부, 규칙 검사 |
| LB-07 | 맥락별 독립 프롬프트, 수동 2차 AI 입력 | 통합본/개별 카드, 기준 분량, Drive 저장, 답변 연결 |

이 항목은 기존 명세의 **사용 계약**을 이어받은 것이다. 기존 PC 구현 파일을 복사했다거나 동일한 모델/평가 결과를 재현했다는 뜻이 아니다. 개인 문서·Drive ID·비공개 팩·기존 사전·실측 자료는 조사/시험에 사용하지 않았다.

## 5. 동등성 확인이 필요한 다음 작업

실제 `prompt-token-saver` 브라우저 어댑터를 채택하려면 먼저 고정 Python baseline의 합성 입출력 fixture를 만들고, 문장/좌표·숫자 정규화·그룹·앵커·의미 검사·fallback·최종 분량을 같은 사례에서 비교해야 한다. `RunReport` 형태만 닮게 만드는 것은 엔진 parity의 증거가 아니다. 의미 검사나 scorer가 없는 상태에서는 해당 측정치를 `None/UNAVAILABLE`로 유지한다.

현재 검증 범위는 앱의 Node 계약 시험과 빌드, 별도 기록한 브라우저 UI 확인이다. SDK의 가짜 Worker 시험은 로드/취소/정리/점유 계약을 검증하며, 실제 모델 정확도·지연·메모리를 검증하지 않는다.

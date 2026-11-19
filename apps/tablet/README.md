# prompt token saver : 토큰을 아끼세요

[모바일·태블릿 Beta 바로 열기](https://ai-agent-orchestrator.github.io/prompt-token-saver/)

Google 로그인 없이 원문 → 1차 요약 → 2차 요약 → 복사를 사용합니다. 기본은 압축 발췌이며 선택한 로컬 모델은 실제 요약을 생성합니다. 요약칸과 복사·Drive 요약 파일은 `SummaryResult.body`만 사용합니다. 엔진·검수 정보는 접이식 판정 보드에 표시합니다.

## 실행

저장소 루트의 `spec/constants.json`도 빌드에 필요하므로 앱 디렉터리만 따로 복사하지 마세요. Node.js 24를 사용합니다.

```sh
cd apps/tablet
npm ci
npm run dev
npm run check
```

## 출력 계약

- 본문: LF 정규화 원문 코드포인트 수의 1/3 이하 (고정 300자 상한 없음).
- 상태가 OK일 때만 본문·복사·저장 가능. 중단 시 기존 결과 유지.
- 2차는 원문 해시·근거를 유지하며 1차보다 짧게 출력하거나 NOT_REDUCIBLE.
- 원문 복사·선택 영역 붙여넣기, 결과별 복사, 권한 거부 시 수동 안내.
- 가리기 결과가 상한을 넘으면 본문 밖에서 경고하고 명시적으로 허용한 텍스트만 복사·저장.
- 보드의 문턱값 미리보기는 저장된 후보만 재판정. 엔진 재실행은 별도 버튼.
- 판정은 규칙 기반이며 임계값은 보정 전. 모든 사실 보존·의미 정확성 보증은 아님.

[엔진 사양](../../spec/summary-contract.md) · [검증 기록](../../docs/BRIEF_IMPLEMENTATION.md)

## 선택형 로컬 모델

설정에서 호환 `.litertlm` 파일을 선택합니다. WebGPU·Worker·HTTPS 지원이 필요하며 모델 파일은 자동 다운로드하지 않습니다. 무료 기본 경로는 모델·네트워크 없이 실행합니다. SDK runtime은 build의 runtime/에 포함되며 초기 앱 설치 캐시에 넣지 않습니다. 모델별 품질·실제 기기 검수는 별도입니다.

## 선택형 Google Drive

운영자가 Google Drive API·Docs API·Picker와 Web OAuth 클라이언트를 설정한 경우에만 사용합니다. `.env.example`을 참고하여 VITE_GOOGLE_CLIENT_ID, VITE_GOOGLE_API_KEY, VITE_GOOGLE_APP_ID 공개 값을 설정하세요. client secret·refresh token은 넣지 마세요. OAuth origin은 https://ai-agent-orchestrator.github.io 입니다. 방문자는 drive.file 범위로 로그인하고 선택한 원문을 읽으며 앱은 새 문서를 만듭니다. 토큰은 탭 메모리에만 유지됩니다.

## 배포

현재 공개 주소는 `claude/tablet-beta-pages` 브랜치 루트를 게시합니다. `npm run check` 후 `dist/` 정적 파일과 `.nojekyll`, BUILD_INFO.json을 해당 브랜치에 교체·커밋·push합니다. 소스는 main에 둡니다. 개인 원문·로컬 복구 장부·모델 파일은 게시하지 않습니다. 저장소의 수동 Actions Pages workflow는 별도 방식이며 현재 branch 게시 설정을 자동 변경하지 않습니다.

기존 홈 화면 앱이 이전 화면을 유지하면 이전 탭을 모두 닫은 뒤 다시 열어 주세요. 최초 접속에는 인터넷이 필요합니다. 실제 홈 화면 설치·오프라인·Google 실계정 검증은 별도입니다.

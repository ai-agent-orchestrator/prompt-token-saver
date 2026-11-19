# prompt token saver : 토큰을 아끼세요

원문 붙여넣기 → 요약 1 → 필터로 한 번 더 요약한 요약 2 → 복사 또는 Drive 저장을 한 화면에서 사용하는 정적 웹 앱입니다. 원문과 두 요약을 세 텍스트 칸에서 비교하고, Drive에 저장한 결과는 아래 목록 표에서 확인합니다. 긴 자료의 맥락은 통합 요약 안에서 유지합니다. Gemini·Codex·Claude에는 사용자가 원하는 결과를 직접 복사해서 넣습니다.

기본 기능은 무료로 사용하는 브라우저 원문 발췌·규칙 필터입니다. 유료 AI API, 서버 추론, API 키 결제를 연결하지 않습니다. 외부 AI 서비스의 이용 조건·사용량은 해당 서비스에 따릅니다. 사이트 방문자는 개발 서버를 실행하거나 자기 OAuth 앱을 만들 필요가 없습니다.

## Drive 없이 먼저 써보기

Google 설정·로그인·모델 파일 없이 시작할 수 있습니다. **예제 또는 붙여넣기 → 요약하기 1 → 필터로 요약하기 2 → 복사** 순서로 확인합니다. Drive를 연결하지 않았다는 이유로 요약을 막지 않습니다. 저장·원격 목록 조회를 눌렀을 때만 연결 설정을 사용합니다. [Beta 검수 순서](../../docs/BETA_CHECKLIST.md)에 Drive 미연결과 연결 경로를 따로 기록합니다.

## 로컬 실행

개발 환경은 Node.js 24를 권장합니다. 저장소 루트에서 다음 순서로 실행합니다.

```sh
cd apps/tablet
npm ci
npm run dev
```

터미널에 표시된 주소를 브라우저에서 엽니다. Google 설정 없이 원문 붙여넣기와 합성 예제로 시작할 수 있습니다. 약 35기준쪽의 합성 자료를 불러와 정리한 뒤 두 결과를 비교하고 복사합니다. 기준 1쪽은 공백·줄바꿈 포함 1,500코드포인트이며 Google Docs의 실제 인쇄 쪽수와는 다릅니다.

```sh
npm run check
npm run build
npm run preview
```

`check`는 테스트와 프로덕션 빌드를 실행합니다. `build`는 `dist/`에 정적 배포물을 만듭니다. `vite.config.js`의 상대 경로 `base: './'`는 GitHub Pages의 repository 하위 경로를 지원합니다. 앱 방문자에게 필요한 것은 HTTPS 사이트와 브라우저뿐이며, Node.js는 개발·빌드용입니다.

## 처리 범위

- 기본 정리는 원문 문장을 선택합니다. 숫자·단위·부정·조건 등 보호 사실은 남기며, 분량을 맞출 수 없거나 처리에 실패하면 검토 필요 상태를 보여 줍니다. 1차 AI 자료의 주장을 실제 세계의 사실로 인증하지 않습니다.
- 2차 정리는 1차 결과를 필터에 다시 통과시킨 출력입니다. 첫 원문과 비교할 근거·보호 사실을 유지하며, 외부 AI에 새 조사를 요청한 결과와 구분합니다.
- 이름·기관명은 사용자가 가릴 단어로 지정하고, 이메일·전화번호 등은 기본 규칙으로 마스킹합니다. 복사·Drive 저장은 마스킹된 산출물을 사용합니다.
- 선택 로컬 AI는 사용자가 가진 Web 호환 `.litertlm` 파일을 고급 설정에서 선택합니다. 첫 구현은 AI의 **정확한 원문 근거 선택**을 허용하며, 검증되지 않은 자유 의역을 정상 결과로 채택하지 않습니다. 공개 `prompt-token-saver` 엔진 전체와의 동등성·이식 완료를 주장하지 않습니다.
- 모델 가중치를 자동 다운로드하지 않습니다. `npm ci`는 고정 SDK를 설치하고 `dev`/`build`는 SDK의 JS/WASM을 로컬 배포 자산으로 복사합니다. 현재 전체 runtime 자산은 약 123MB(117MiB, 네 WASM 변형 합계)이며 초기 앱 화면의 다운로드·선행 캐시에서 제외됩니다. 로컬 AI를 선택할 때 필요한 브라우저 변형을 요청하고 사용한 자산만 캐시합니다. 모델 파일·Google 문서·토큰은 서비스 워커에 캐시하지 않습니다.

기본 브라우저 흐름과 가짜 API/모델 계약은 자동 테스트로 검사합니다. 실제 Google 계정의 OAuth·Picker·쓰기·목록 조회, 실제 태블릿 GPU 추론·성능, GitHub Pages의 실배포는 아직 검증 전입니다. API 경로 테스트를 실기기 품질 증거로 사용하지 않습니다.

## Google Drive: 운영자가 한 번 설정

운영자가 Google Cloud 프로젝트에서 Drive API, Docs API, Google Picker API와 Web OAuth client·동의 화면을 설정합니다. 방문자는 Google 로그인 후 파일별 접근을 허용합니다. scope는 `drive.file`이며 앱이 만든 산출물과 사용자가 Picker에서 선택한 파일에 접근합니다. 앱은 원문 파일 ID의 쓰기를 차단합니다. 저장 목록은 **이 OAuth 앱이 만든 결과 폴더**만 조회하며 사용자의 전체 Drive 목록이 아닙니다.

개발용 설정은 `.env.example`을 `.env`로 복사해 아래 공개 값 세 개를 입력합니다. 이 값들은 배포 JS에 보이므로 OAuth client secret, refresh token, 서비스 계정 키를 넣으면 안 됩니다.

| 환경 변수 | 값 |
|---|---|
| `VITE_GOOGLE_CLIENT_ID` | 운영자 Web OAuth client ID |
| `VITE_GOOGLE_API_KEY` | 웹사이트·API가 제한된 Picker API key |
| `VITE_GOOGLE_APP_ID` | 같은 Google Cloud 프로젝트의 숫자 번호 |

OAuth Authorized JavaScript origins에는 `https://사용자.github.io`처럼 scheme·host를 등록하고 `/저장소/` 경로는 넣지 않습니다. 개발용 origin도 실제 localhost host·port에 맞게 별도로 등록합니다. Picker key는 앱 웹사이트와 `https://docs.google.com/*`를 허용하고 사용하는 Picker/Drive API로 제한합니다. 동의 화면의 테스트/공개 상태와 허용 계정도 배포 대상에 맞게 설정합니다. [Google의 OAuth 설정](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid), [Picker 웹 설정](https://developers.google.com/workspace/drive/picker/guides/web-picker)을 따릅니다.

access token은 탭 메모리에만 유지합니다. 만료되면 사용자 동작으로 다시 로그인하고 저장 장부를 확인해 이어 갑니다. 결과불명 생성은 자동 반복하지 않으며, 새 문서의 본문을 읽어 확인한 뒤 저장 완료로 표시합니다. 복구 보관을 켠 작업만 이 기기에서 새로고침 후 이어 갈 수 있습니다. Drive 출력은 다른 기기에서 열 수 있지만 브라우저 작업 장부·개인 사전·모델은 자동 동기화하지 않습니다.

## GitHub Pages: 검토 후 수동 배포

배포 workflow는 저장소 루트의 `.github/workflows/tablet-pages.yml`입니다. `workflow_dispatch`만 선언했으므로 push나 PR로 자동 배포되지 않습니다. 이 작업에서는 workflow를 실행하거나 사이트를 배포하지 않았습니다.

1. 공개 배포물에 개인 자료·비공개 팩·키가 없는지 확인합니다. 무료 GitHub Pages는 공개 저장소에서 사용할 수 있습니다. 비공개 설계 문서가 있는 저장소 전체를 공개 전환하지 말고, 필요하면 검토된 앱만 공개용 저장소로 분리합니다. [GitHub Pages 이용 조건](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
2. 저장소 Settings → Pages의 Source를 **GitHub Actions**로 설정합니다. Settings → Secrets and variables → Actions → Variables에 위 `VITE_GOOGLE_*` 세 값을 등록합니다. 이는 운영자 공개 설정이며 방문자의 토큰이나 개인 문서가 아닙니다. Google 연결을 제공하지 않을 때는 비워 두고 기본 로컬 기능만 운영할 수 있습니다.
3. 기본 브랜치에 검토한 workflow가 반영된 뒤 Actions → **Publish tablet research to Pages** → Run workflow에서 배포할 브랜치를 직접 선택합니다. Node.js 24에서 `npm ci`·테스트·빌드가 통과하면 `apps/tablet/dist`만 Pages artifact로 올리고 전용 deploy job이 게시합니다.
4. 배포 origin을 Google OAuth·Picker key 허용 목록에 반영하고 실제 계정·태블릿에서 로그인, 저장, 표 새로고침, 재시도·취소를 확인합니다. 새 origin은 이전 origin의 IndexedDB·OPFS 저장소와 다릅니다.

구현된 배포 workflow는 원문·브라우저 기록을 수집하지 않습니다. 앱 정적 파일만 배포하며, 공개 코드 안에 개인 자료와 비공개 엔진 레시피를 넣지 않습니다. SDK 고지와 전체 라이선스는 빌드의 `runtime/NOTICE.txt` 및 LICENSE 파일에 포함됩니다. 사용자가 선택한 모델의 라이선스는 별도로 확인합니다.

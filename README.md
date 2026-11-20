# prompt token saver : 토큰을 아끼세요

**Engine ver1 최종판 · Serverless · Tablet / Mobile**

[브라우저에서 바로 열기](https://ai-agent-orchestrator.github.io/prompt-token-saver/)

설치 없이 원문을 붙여넣고 **요약 1 → 요약 2 → 복사**를 사용합니다. 요약 2는 선택이며 요약 1에서 곧장 Drive에 저장할 수 있습니다. 요약 1 결과의 전체 지우기도 제공합니다.

- 실제 엔진은 `apps/tablet/engine-src/research_engine.py`의 ver1입니다.
- LiteRT-LM 0.19.0과 약 344MB Qwen3-0.6B 모델을 이 기기에 자동 준비·재사용합니다.
- 최초 접속/모델 준비에는 인터넷과 저장 공간, 실행에는 WebGPU 등 호환 브라우저 환경이 필요합니다.
- Google 로그인 없이 요약·복사가 가능합니다. Google 로그인과 운영자 OAuth 설정은 Drive 기능에만 필요합니다.
- 유료 AI API나 개발자 서버를 요구하지 않습니다. 실제 태블릿의 모델 속도·품질·홈 화면 설치·오프라인 사용은 Beta 검수 대상입니다.
- 문장 비율로 선택하므로 모든 입력이 토큰 50% 이하가 되는 것은 아닙니다. 실행 통계는 본문과 분리합니다.

최종 소스는 **main**에 있습니다. GitHub Actions가 main의 앱을 기존 Pages 주소에 배포합니다.

[앱 개발·실행](apps/tablet/README.md) · [ver1 검증과 한계](apps/tablet/RELEASE.md)

## 개발

Node.js 24에서:

```sh
cd apps/tablet
npm ci
npm run check
node scripts/test-ver1-wasm.mjs
```

Python ver1 코어 검사는 `PYTHONPATH=apps/tablet/engine-src`를 설정하고 `apps/tablet/tests-python`의 unittest를 실행합니다. 기존 Python CLI 패키지와 과거 개발 자료도 저장소에 유지합니다.

개인 원문·인증 토큰·모델 파일은 Git에 올리지 않습니다. 로컬 기기에 원문을 보관하는 기능과 마스킹한 결과를 복사/저장하는 기능을 구별합니다.

[이전 한국어 문서](README.ko.md) · [이전 English 문서](README.en.md) — 과거 CLI·Brief 구현 기록입니다. 현재 모바일 앱 동작은 이 README와 apps/tablet 문서를 기준으로 합니다.

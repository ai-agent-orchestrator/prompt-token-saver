# Prompt Token Saver · Engine ver1 최종판

원문 → 요약 1 → 요약 2 → 복사. 요약 2는 선택이며 요약 1에서 바로 Drive에 저장할 수 있습니다.

실제 선택기는 engine-src/research_engine.py의 ver1입니다. 문장 비율로 선택하고 로컬 모델 제안을 기존 ver1 어휘 검사로 확인합니다. 현재 개선판의 누적 캐시·병합 검증 레시피·2 do list는 포함하지 않습니다. 문장 선택 비율과 출력 토큰 비율은 다르며 모든 입력이 50% 이하라는 보장은 없습니다.

LiteRT-LM 0.19.0 + 약 344MB Qwen3-0.6B를 자동 준비합니다. 최초 인터넷·WebGPU 호환 환경·기기 저장 공간이 필요합니다. Google 로그인은 Drive에만 필요합니다. 유료 AI API를 사용하지 않습니다.

Node.js 24에서 이 폴더의 npm ci → npm run check → node scripts/test-ver1-wasm.mjs. 출력은 dist/입니다.

배포는 main의 GitHub Actions가 담당합니다. 별도 Pages 소스 브랜치는 사용하지 않습니다. 운영자의 공개 Google OAuth 설정이 없으면 Drive 연결 설정이 필요하지만 요약·복사는 그대로 사용할 수 있습니다.

실행 정보는 요약 아래에만 표시하고 복사·Drive 저장에는 본문만 포함합니다. 실제 태블릿의 모델 속도·의미 품질은 별도 검수 대상입니다.

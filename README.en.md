# prompt token saver : Save your tokens

**v0.1.0-beta.1 · Serverless · Tablet / Mobile · Dark Mode**

[한국어](README.ko.md) · [English](README.en.md)

**[Open the public Mobile / Tablet Beta](https://ai-agent-orchestrator.github.io/prompt-token-saver/)**

Open this address on your phone or tablet. No development environment or source download is needed. Use it in the browser, or add it to the home screen as an app.

### Add it to the home screen

- **Android phone/tablet:** open in Chrome → browser menu → **Install app** or **Add to Home screen**.
- **iPhone/iPad:** open in Safari → **Share** → **Add to Home Screen**. Enable “Open as Web App” if offered.
- Launch **token saver** from the home screen. An app-store download or APK is not required.

Google login is optional for paste → Summary 1 → Summary 2 → copy. Initial loading and Drive operations need internet. Actual device installation and offline use remain Beta verification items. See the [PWA installability guide](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).

## New summary engine — Brief 1.0

The body is at most **300 Unicode codepoints AND one third of the normalized source**. Whitespace, punctuation and newlines count. The former research-card renderer and its repeated instructions have been removed.

1. Paste a source or select **예제** (Example). The source also has copy and paste buttons.
2. Select **요약하기 1**. Only the summary body appears in the result field.
3. Select **필터로 요약하기 2**. A successful result must be shorter than stage one. Otherwise stage one is retained and the status line explains why.
4. Copy either successful body. Google Drive is optional.
5. Open **판정 보드** (Decision board) for candidates, meaning/anchor/length checks and omitted topics/numbers. Threshold preview does not alter the body; use the explicit rerun button to apply changes.

### Processing and limits

- The default is deterministic **compressed extraction**, without a model. It selects sentences and applies explicit conservative rules. Omitted information is recorded separately.
- Rules check numeric relationships, subjects, negation and conditions in selected sentences. They do not prove semantic correctness or preserve every fact. A 300-character brief can omit important topics; inspect the board.
- Select a compatible local `.litertlm` file for on-device summary generation. Generated candidates and extractive fallbacks pass the same checks. Actual model quality and tablet GPU validation remain separate.
- Oversized sentences are never sliced into partial output. Failure details stay outside the body.
- At least 120 normalized source codepoints are needed. Changing the source requires a new stage-one run.
- If masking expands the result beyond budget, review and explicitly allow that outbound text before copying or saving.
- No paid inference API, developer backend or sign-up. Model weights are not automatically downloaded.
- Character counts are not token counts or token savings. Actual surprisal and browser vector search are not features of this release.

The UI retains dark mode with electric blue borders/focus, a yellow Lumi accent, and responsive source/stage-one/stage-two panels.

## Development

Node.js 24 and Python 3.10+:

```sh
cd apps/tablet
npm ci
npm run dev
npm run check
```

From the repository root:

```sh
python -m pip install -e '.[test]'
python -m pytest -q
pts brief prompt_token_saver/demo/notes_ko.md
pts brief prompt_token_saver/demo/notes_ko.md --stage2 --json
```

The browser JS engine is the user execution path; Python `brief/` is the matching CLI/reference implementation. Shared fixtures compare stage-one and stage-two bodies/statuses across languages. Legacy Python `compress()` is retained without a global budget and is not used by the web app.

- [Engine contract](spec/summary-contract.md)
- [Implementation and validation](docs/BRIEF_IMPLEMENTATION.md)
- [API](docs/API.md)
- [App setup, optional Drive and deployment](apps/tablet/README.md)

## Google Drive

Summarization/copy do not require Google. Import/save/list require operator public configuration and visitor login with per-file `drive.file` access. The app writes new summary documents without overwriting the source. Actual-account testing remains separate.

## License

[MIT](LICENSE). Optional SDK/model licenses also apply. See [third-party notices](NOTICE.md).

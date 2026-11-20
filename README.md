# PrismLLM

iOS fork of [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi): a client-side router for free-tier LLM keys, wrapped in a SwiftUI + WKWebView shell and shipped as an unsigned `.ipa`.

- `src/router.ts`: key rotation, per-key rpm throttle, 429/401/5xx cooldowns, strategies (failover / fastest / reliable / pinned model), live model sync
- `src/native.ts`: Swift bridge (URLSession streaming fetch, Keychain, haptics, share sheet)
- `src/storage.ts`: persistence, AES-GCM encrypted key backup
- `src/app.ts`, `web/`: chat UI
- `ios/`: XcodeGen spec + Swift shell
- `.github/workflows/build-ipa.yml`: macOS runner, unsigned build, uploads `PrismLLM.ipa`

Settings has an **On-device / FreeLLMAPI server** toggle. In server mode the app calls `<url>/v1/chat/completions` with your `fla_` key.

Local build: `npm install && npm run build`, then `cd ios && xcodegen generate`.

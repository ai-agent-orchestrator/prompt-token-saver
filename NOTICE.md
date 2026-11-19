# Third-party notices

| Component | Use | License |
| --- | --- | --- |
| [LLMLingua](https://github.com/microsoft/LLMLingua) (Microsoft) | Idea: token surprisal as a signal of information. Any code reused will carry its copyright notice here. | MIT |
| [Chroma](https://github.com/chroma-core/chroma) | Vector store (planned dependency) | Apache-2.0 |
| [Qwen3](https://github.com/QwenLM/Qwen3) | Default local model (downloaded by the user, not bundled) | Apache-2.0 |
| [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) | Optional tablet-local model adapter, SDK pinned to 0.19.0; no model weights bundled | Apache-2.0 |
| [LiteRT wasm-utils](https://github.com/google-ai-edge/LiteRT) | Loader used by the optional browser SDK | Apache-2.0 |

The serverless Tablet / Mobile Beta uses model-free extractive filtering by default.
Its optional SDK is separate from the initial app download. Full Apache-2.0 license
texts and component notices are included in generated runtime assets; see
`apps/tablet/licenses/Apache-2.0.txt` and `apps/tablet/docs/reuse-manifest.md`.

Models are downloaded by the user and are not redistributed in this repository. If you choose a Llama model, its
license asks you to display "Built with Llama".

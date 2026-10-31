# Evaluation provider policy

The user requires real providers for evaluating Miu's character engine and memory behavior. Apply this policy to historical replay, daily growth, regression scenarios, acceptance reports, and model-quality comparisons.

- Run character and memory behavioral evaluations with the real provider and actual model requests. Evaluation commands default to real and must reject a fake provider.
- Use the fake provider only for frontend and pipeline development. Do not use fake replies or authored reference dialogue as evidence that character or memory behavior works.
- Offline doubles are permitted for clearly labeled unit or harness-logic checks, such as schemas, report formatting, request contracts, and lifecycle orchestration. They do not establish character quality, memory quality, or model performance. Never relabel a fake provider as real to bypass evaluation restrictions.
- Keep earlier fake runs as `diagnostics_not_model_evaluation` when preserving provenance. Exclude them from real-provider quality conclusions, acceptance counts, and performance comparisons.
- If a real request is blocked or fails, record the actual error and attempted coverage. Do not substitute fake answers or claim unattempted cases passed.
- Load credentials through the server-side environment or an explicitly selected environment file. Never print or commit API keys or `.env` contents.

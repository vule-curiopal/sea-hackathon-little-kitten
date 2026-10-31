# Spoken fixtures (fake mode only)

Copied from the user's local `D:/Intern/LittleBuddy_Implementation/frontend/public/voice-samples/` for wiring and playback tests. No provider was called to produce these files during this implementation.

| File / fixture ID | Source voice ID | Exact spoken sample |
| --- | --- | --- |
| `vi.wav` / `voice_sample_vi` | `mgBpvrNosWzExdPuRbXP` | Chào bạn! Mình là Buddy nè. Hôm nay bạn muốn chơi trò gì? |
| `en.wav` / `voice_sample_en` | `fBD19tfE58bkETeiwUoC` | Hi there! I'm Buddy. What would you like to play today? |

These are explicitly selected reference **Buddy** samples, not generated Miu replies or recognition of the uploaded microphone audio. Fake STT uses the selected fixture declaration; fake reply/audio match the sample exactly. Use real mode or replace the response adapter to test actual Miu dialogue. Keep the fake-mode indicator visible in any test UI.

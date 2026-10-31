# ElevenLabs realtime STT — triển khai ưu tiên

Cập nhật 31/10/2026 theo lựa chọn của người dùng: **ElevenLabs tự phát hiện lời nói và lọc nền; local VAD model để sau**. Runtime realtime đã được triển khai và kiểm thử local. Cấu hình phát hành chọn khoảng im lặng **1 giây** theo yêu cầu mới; các kết quả benchmark cũ bên dưới dùng 3 giây và không đại diện cho ngưỡng mới.

## Luồng đang có

```text
Talk → xin mic và chuẩn bị WebSocket
     → AudioWorklet lấy mẫu từ cùng microphone
     → PCM16 mono 16 kHz, chunk 200 ms
     → WSS cùng origin tới backend Miu
     → ElevenLabs scribe_v2_realtime với VAD + lọc nền
     → partial chỉ để cập nhật tạm; committed segment vào buffer backend
     → khoảng im lặng 1 giây tạo end candidate
     → browser dừng mic, flush PCM cuối, gửi audio.end(last_seq)
     → backend gửi manual commit cuối và chờ committed acknowledgement
     → ghép full transcript → TurnService → engine/GPT → TTS → playback
```

Không gọi engine/LLM theo từng chunk, partial hay segment. `audio.end` là yêu cầu chốt toàn lượt, không đóng WebSocket sớm. Nếu acknowledgement cuối chứa text rỗng, đó vẫn là xác nhận hợp lệ cho phần đuôi chỉ có silence; giữ các đoạn đã chốt trước đó.

Frontend hiển thị lời người dùng ngay từ `transcript.final`, trước khi chờ engine/TTS. Lời đã nhận dạng được giữ nếu bước trả lời lỗi hoặc người dùng dừng lượt; placeholder processing không được ghi đè transcript thật. Event của lượt cũ/hủy hoặc sau reset không được cập nhật hội thoại. Partial không gọi engine hoặc query DB.

**Probe thật đã xác minh:** VAD mode chấp nhận manual commit cuối và trả `committed_transcript` rỗng sau auto commit. Đây là hành vi đã quan sát trên tài khoản/model hiện tại, không phải một event mới tên `final_transcript` của ElevenLabs. Backend chỉ phát `transcript.final` của Miu sau khi drain thành công.

## Cấu hình

```dotenv
MIU_PROVIDER=real
VOICE_INPUT_MODE=elevenlabs_realtime
STT_LOGGING=1
ELEVENLABS_VAD_SILENCE_MS=1000
```

API key vẫn nằm trong `.env` backend. Không giữ alias `ELEVENLABS_ENABLE_LOGGING=false` cùng `STT_LOGGING=1`, vì cấu hình mâu thuẫn sẽ bị từ chối. Root `.env` đã được đồng bộ lựa chọn normal logging như brain; các credential khác được giữ nguyên.

| Gửi tới ElevenLabs | Giá trị |
| --- | --- |
| `model_id` | `scribe_v2_realtime` |
| `audio_format` | `pcm_16000` |
| `language_code` | `vi` hoặc `en`, theo phiên |
| `commit_strategy` | `vad` |
| `filter_background_audio` | `true` |
| `vad_silence_threshold_secs` | `1.0` mặc định, từ env milliseconds |
| `vad_threshold` | **Không gửi**; dùng mặc định provider cho lọc nền. Probe hiện trả `0.15` |
| `min_speech_duration_ms`, `min_silence_duration_ms` | **Không gửi**; probe hiện trả `100/100` ms |
| `include_timestamps`, `include_language_detection`, `no_verbatim` | `false` |
| `keepalive_interval_ms` | `1000` |
| `enable_logging` | Không gửi trong normal mode. Nếu chủ động yêu cầu ZRM mà provider không áp dụng, backend từ chối session |

Backend kiểm tra config mà `session_started` trả về để tránh coi một session không bật đúng VAD/lọc nền là session hợp lệ. Không có auto-tuning tất cả tham số theo từng microphone; provider xử lý phân loại theo chế độ đã chọn. [API](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime), [VAD và lọc nền](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies).

## Lifecycle và giới hạn

- Tối đa 30 giây audio/lượt. Khi vẫn đang nói mà chạm giới hạn: hủy và yêu cầu nói ngắn hơn, không ép gửi câu dở.
- Không có text được nhận dạng trong 8 giây sau ready thì từ chối; guard này có tính đến độ trễ khởi động/partial của provider.
- Chờ upstream ready tối đa 10 giây; chờ drain cuối tối đa 10 giây. Timeout không được biến thành transcript cuối.
- Sequence phải liên tục; kiểm tra `last_seq`, byte/duration limit và backpressure. Không drop chunk hoặc replay/reconnect âm thầm.
- Một reservation trên profile ngăn config, lượt khác hoặc chuyển ngày cạnh tranh. Hủy, hide tab, mic gián đoạn, WS đóng và shutdown đều abort pending work.
- Engine nhận full text qua cổng hiện có. Bản integrated tiếp tục dùng character/memory engine; bản standalone dùng GPT stateless. Chỉ playback receipt thật mới có thể hoàn tất learning trong integrated mode.
- Có thể giữ bản cũ bằng `VOICE_INPUT_MODE=rms_batch`. Fake mode mặc định dùng RMS/batch; không giả lập realtime provider thành kết quả thật.
- Model Silero/VAD local chưa được cài hoặc triển khai.

### Database chỉ sau full transcript trong luồng STT

Kiểm tra trace thật 20 file: **147 partial, 0 query/transaction từ lúc stream ready đến khi có acknowledgement cuối**. Callback partial chỉ gửi trạng thái; committed segment chỉ vào buffer RAM. Có một reconcile ở startup; lần đọc này đã được bỏ khỏi `SpeechStreamService.start`. Token/session/reservation dùng RAM sau bước tạo phiên/config; `TurnService` vẫn reconcile DB và chặn state thay đổi sau full transcript, trước khi gọi engine.

Probe thật sau sửa xác nhận **0 query/transaction từ khi mở WebSocket đến full transcript**, sau đó engine/TTS hoàn tất. Test regression kiểm tra 147 partial và trường hợp state đổi trước lúc gọi engine. Các API tạo phiên/config, panel hoặc maintenance độc lập vẫn có thể truy cập DB; chúng không do từng partial kích hoạt.

[Trace kiểm tra](../../reports/voice-latency-2026-10-31-14-35-42/partial-db-audit.json). Khoảng 120 query gây chậm trong benchmark nằm **sau full transcript**; thay đổi startup này không loại bỏ phần chi phí đó.

Với realtime, `timings_ms.stt` đo phần drain sau `audio.end`, không phải toàn bộ thời gian stream/thu. `server_total` tính từ finalize đến khi có kết quả, gồm drain; thời gian người dùng nói và chờ endpoint được đo riêng qua sự kiện stream.

## Contract và module

Contract cụ thể nằm trong [shared API contracts](../api-contracts.md#realtime-speech-turn).

Module backend: `modules/speech-streams` quản lý auth/WS, reservation và transcript; `providers/elevenlabs/realtime-stt.provider.ts` quản lý upstream. `server-runtime.ts` gắn WS upgrade và đóng kết nối khi shutdown. Browser: `voice-client/src/realtime` quản lý AudioWorklet, PCM encoder và socket; controller dùng chung playback.

Không cần thêm một REST endpoint tạo stream/finalize: message đầu xác thực và giữ reservation; `audio.end` yêu cầu finalize trên cùng WS. Không gửi text từ browser quay lại để thay transcript server.

## Chạy và kiểm tra

```powershell
npm ci
npm run build
npm run dev

# Kiểm tra orchestration bằng doubles; không phải model quality.
npm run test:voice

# Có tính phí, dùng provider thật trên instance test riêng, không chạm production/session memory.
node --env-file=.env --import tsx scripts/verify-realtime-voice.ts --real
node --env-file=.env --import tsx scripts/verify-realtime-browser.ts --real
```

Browser acceptance script dùng Edge đã cài, microphone giả bằng WAV có khoảng nghỉ 2,2 giây và padding phục vụ kiểm thử browser. Chạy với gesture thật, AudioWorklet, WS, GPT/TTS thật và playback thật trong browser. Đây không phải kiểm thử mic vật lý/Safari/iPad.

Kết quả đã ghi:

- Typecheck voice + engine, **159 test voice trong 15 file** và **24 test frontend** qua. Đây là kiểm tra contract/orchestration, không dùng để kết luận chất lượng model.

- [20 audio qua realtime thật](../../test-assets/voice-pipeline/realtime-validation.json): **16 lượt hoàn tất**, mỗi lượt đúng **1 dispatch GPT** với full transcript; **4 ca không gọi engine** gồm 2 giọng quá nhỏ và 2 noise-only. Không có endpoint trước phần speech tham chiếu; không gọi STT batch.
- Hai ca nghỉ 2,2 giây giữ được cả hai mệnh đề. Nhiễu mạnh kết thúc khoảng **7,8 giây audio** thay vì giữ tới 30 giây như baseline RMS. Tên riêng vẫn có thể nhận sai; lọc nền không bảo đảm nhận dạng đúng mọi chữ.
- [Browser acceptance](../../test-assets/voice-pipeline/realtime-browser-validation.json): full transcript tiếng Việt của hai mệnh đề, 1 dispatch, MP3 và playback hoàn tất, không có page error. Dùng viewport 768×1024, không phải iPad thật.
- Giọng quá nhỏ vẫn là giới hạn: Việt bị `unclear_audio`, Anh gặp upstream close; cả hai đều không dispatch text tạm tới engine.

## Deploy sau khi review

Frontend và backend phải cùng phiên bản. Nginx cần WS upgrade cho `/api/sessions/{session_id}/speech-stream`; template riêng Miu đã được cập nhật tại `deploy/miu/nginx-https.conf`. `/api/voice/capabilities` cho frontend biết mode. Giữ các vhost/project khác nguyên vẹn; chưa apply template hoặc restart service trên server trong lần triển khai local này.

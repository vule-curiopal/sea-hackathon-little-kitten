# ElevenLabs realtime STT — triển khai ưu tiên

Cập nhật 31/10/2026 theo lựa chọn của người dùng: **giữ chuột, phím Space hoặc nút cảm ứng để nói; thả để gửi**. Upstream ElevenLabs dùng **manual commit** và tiếp tục lọc nền; local VAD model để sau. Khoảng nghỉ khi còn giữ không chốt transcript hoặc gửi lượt Miu. Các kết quả benchmark cũ bên dưới dùng VAD tự kết thúc và ngưỡng 3 giây; chúng không xác minh hành vi giữ/thả mới.

## Luồng đang có

```text
Giữ nút Talk / Space / cảm ứng → xin mic và chuẩn bị WebSocket
     → AudioWorklet lấy mẫu từ cùng microphone
     → PCM16 mono 16 kHz, chunk 200 ms
     → WSS cùng origin tới backend Miu
     → ElevenLabs scribe_v2_realtime với manual commit + lọc nền
     → partial chỉ để cập nhật tạm; vẫn thu qua các khoảng nghỉ khi còn giữ
     → thả nút → browser dừng mic, flush PCM cuối, gửi audio.end(last_seq)
     → backend gửi manual commit cuối và chờ committed acknowledgement
     → ghép full transcript → TurnService → engine/GPT → TTS → playback
```

Không gọi engine/LLM theo từng chunk hoặc partial. `audio.end` là yêu cầu chốt toàn lượt, không đóng WebSocket sớm. Chỉ transcript đã commit sau yêu cầu này mới được gửi cho engine. Acknowledgement rỗng kết thúc drain nhưng bị từ chối với `unclear_audio`; không thay bằng partial tạm.

### Giữ để nói, thả để gửi

Backend giữ trạng thái listening qua mọi khoảng nghỉ; partial mới là revision của cả lượt, không phải đoạn để nối lại. Backend không phát `turn.end_candidate`, không chuyển sang `end_requested` và không đặt deadline 3 giây sau khoảng nghỉ. Chỉ `audio.end(last_seq)` do browser gửi sau khi thả mới bắt đầu một manual commit và deadline drain 10 giây. Engine nhận đúng một full transcript sau acknowledgement cuối; giới hạn 8 giây không có speech và 30 giây thu vẫn hủy lượt, không tự gửi. Hủy hoặc mất kết nối trước khi gửi không tạo lượt engine hay learning.

Manual mode loại bỏ race giữa VAD commit cũ đang bay về và acknowledgement cuối. Adapter từ chối rồi đóng upstream nếu nhận committed transcript trước manual commit hoặc nhận commit trùng; service cũng từ chối committed transcript trước khi draining. Không dùng khoảng chờ đoán để chọn transcript cuối. Theo [tài liệu commit chính thức](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies), manual mode tự commit sau khoảng 36 giây audio tích lũy; cả giới hạn wall-clock và byte của Miu đều chặn ở 30 giây.

Kiểm tra mới dùng doubles offline cho protocol/orchestration: hai khoảng nghỉ 3,5 giây vẫn giữ reservation, không gọi engine; thả và drain cuối mới dispatch full transcript một lần. Request-contract tests kiểm tra manual strategy, handshake, commit sớm/trùng và đóng kết nối khi lỗi. Đây không phải bằng chứng chất lượng model hoặc đo latency provider thật.

Frontend hiển thị lời người dùng ngay từ `transcript.final`, trước khi chờ engine/TTS. Lời đã nhận dạng được giữ nếu bước trả lời lỗi hoặc người dùng dừng lượt; placeholder processing không được ghi đè transcript thật. Event của lượt cũ/hủy hoặc sau reset không được cập nhật hội thoại. Partial không gọi engine hoặc query DB.

**Handshake thật của manual mode đã xác minh:** `session_started.config` trả `model_id=scribe_v2_realtime`, `filter_background_audio=true`, `vad_commit_strategy=false`, `keepalive_interval_ms=1000`, `disable_logging=false`. Echo vẫn có VAD silence mặc định 1,5 giây; giá trị này không điều khiển manual mode. Probe VAD cũ và các benchmark bên dưới không được dùng để tuyên bố manual-mode STT đã qua kiểm thử audio mới.

**STT smoke thật 31/10/2026:** chạy trên production host với credential server, audio fixture dài 9,4667 giây có khoảng nghỉ 3,5 giây; nhận 10 partial, **0 commit khi còn giữ**, **1 commit sau release** và transcript thật chứa cả hai mệnh đề. Release đến final là 278,54 ms trong ca này. Artifact cục bộ: `reports/production-live-manual-stt-2026-10-31T09-51-15-909Z/report.json`. Đây là kiểm tra protocol/STT của một fixture, không gọi engine/GPT/TTS và không đo latency voice toàn lượt hay xác minh microphone vật lý. Bộ kiểm tra voice offline hiện qua 202 test, 2 test bỏ qua.

## Cấu hình

```dotenv
MIU_PROVIDER=real
VOICE_INPUT_MODE=elevenlabs_realtime
STT_LOGGING=1
```

API key vẫn nằm trong `.env` backend. Không giữ alias `ELEVENLABS_ENABLE_LOGGING=false` cùng `STT_LOGGING=1`, vì cấu hình mâu thuẫn sẽ bị từ chối. Root `.env` đã được đồng bộ lựa chọn normal logging như brain; các credential khác được giữ nguyên.

| Gửi tới ElevenLabs | Giá trị |
| --- | --- |
| `model_id` | `scribe_v2_realtime` |
| `audio_format` | `pcm_16000` |
| `language_code` | `vi` hoặc `en`, theo phiên |
| `commit_strategy` | `manual` |
| `filter_background_audio` | `true` |
| `vad_silence_threshold_secs` | **Không gửi**; không chốt lượt theo silence |
| `vad_threshold` | **Không gửi**; dùng mặc định provider cho lọc nền. Probe hiện trả `0.15` |
| `min_speech_duration_ms`, `min_silence_duration_ms` | **Không gửi**; probe hiện trả `100/100` ms |
| `include_timestamps`, `include_language_detection`, `no_verbatim` | `false` |
| `keepalive_interval_ms` | `1000` |
| `enable_logging` | Không gửi trong normal mode. Nếu chủ động yêu cầu ZRM mà provider không áp dụng, backend từ chối session |

Backend yêu cầu `session_started` xác nhận đúng model, `filter_background_audio=true` và `vad_commit_strategy=false`. Nếu yêu cầu zero retention thì cũng phải xác nhận `disable_logging=true`; không đổi retention hoặc commit strategy âm thầm khi lỗi. `ELEVENLABS_VAD_SILENCE_MS` và các field `silence_ms` cũ còn giữ để tương thích, không kết thúc lượt manual. [API](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime), [commit strategy và lọc nền](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies).

## Lifecycle và giới hạn

- Tối đa 30 giây audio/lượt. Khi vẫn đang nói mà chạm giới hạn: hủy và yêu cầu nói ngắn hơn, không ép gửi câu dở.
- Không có text được nhận dạng trong 8 giây sau ready thì từ chối; guard này có tính đến độ trễ khởi động/partial của provider.
- Chờ upstream ready tối đa 10 giây; chờ drain cuối tối đa 10 giây. Timeout không được biến thành transcript cuối.
- Sequence phải liên tục; kiểm tra `last_seq`, byte/duration limit và backpressure. Không drop chunk hoặc replay/reconnect âm thầm.
- Một reservation trên profile ngăn config, lượt khác hoặc chuyển ngày cạnh tranh. Hủy, hide tab, mic gián đoạn, WS đóng và shutdown đều abort pending work.
- Engine nhận full text qua cổng hiện có. Bản integrated tiếp tục dùng character/memory engine; bản standalone dùng GPT stateless. Chỉ playback receipt thật mới có thể hoàn tất learning trong integrated mode.
- Có thể giữ bản cũ bằng `VOICE_INPUT_MODE=rms_batch`. Fake mode mặc định dùng RMS/batch; không giả lập realtime provider thành kết quả thật.
- Model Silero/VAD local chưa được cài hoặc triển khai.

### Không ghi conversation memory từ partial transcript

Bản tích hợp tài khoản hiện tại đọc phiên đăng nhập ở `stream.start` và `audio.end` để kiểm tra cookie chủ sở hữu. Các trace 0 query dưới đây được ghi trước khi bổ sung kiểm tra này; chúng không phải số liệu của bản tích hợp hiện tại. Partial transcript vẫn không tự tạo lượt engine hoặc ghi conversation memory.

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

Kết quả lịch sử trước khi chuyển upstream sang manual commit:

- Typecheck voice + engine, **159 test voice trong 15 file** và **24 test frontend** qua. Đây là kiểm tra contract/orchestration, không dùng để kết luận chất lượng model.

- [20 audio qua realtime thật](../../test-assets/voice-pipeline/realtime-validation.json): **16 lượt hoàn tất**, mỗi lượt đúng **1 dispatch GPT** với full transcript; **4 ca không gọi engine** gồm 2 giọng quá nhỏ và 2 noise-only. Không có endpoint trước phần speech tham chiếu; không gọi STT batch.
- Hai ca nghỉ 2,2 giây giữ được cả hai mệnh đề. Nhiễu mạnh kết thúc khoảng **7,8 giây audio** thay vì giữ tới 30 giây như baseline RMS. Tên riêng vẫn có thể nhận sai; lọc nền không bảo đảm nhận dạng đúng mọi chữ.
- [Browser acceptance](../../test-assets/voice-pipeline/realtime-browser-validation.json): full transcript tiếng Việt của hai mệnh đề, 1 dispatch, MP3 và playback hoàn tất, không có page error. Dùng viewport 768×1024, không phải iPad thật.
- Giọng quá nhỏ vẫn là giới hạn: Việt bị `unclear_audio`, Anh gặp upstream close; cả hai đều không dispatch text tạm tới engine.

## Deploy sau khi review

Frontend và backend phải cùng phiên bản. Nginx cần WS upgrade cho `/api/sessions/{session_id}/speech-stream`; template riêng Miu đã được cập nhật tại `deploy/miu/nginx-https.conf`. `/api/voice/capabilities` cho frontend biết mode. Giữ các vhost/project khác nguyên vẹn; chưa apply template hoặc restart service trên server trong lần triển khai local này.

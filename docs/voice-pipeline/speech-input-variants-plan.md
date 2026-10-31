> Cấu hình phát hành hiện chọn ElevenLabs realtime, silence **1 giây** (`ELEVENLABS_VAD_SILENCE_MS=1000`). Mốc 3 giây dưới đây thuộc plan/benchmark ban đầu; local model vẫn để sau.

# Plan: VAD cục bộ và ElevenLabs STT realtime

Ngày: **31/10/2026**. **Cập nhật theo lựa chọn mới:** triển khai **ElevenLabs realtime STT trước**, dùng VAD tự động và lọc nền của provider; **local VAD model để sau**. Bản realtime đã có code và kiểm thử local; xem [hướng dẫn thực tế](elevenlabs-realtime.md). `.env` local đã chọn realtime + normal logging; chưa commit/push hoặc deploy lên server.

## 1. Yêu cầu và phạm vi

Triển khai **hai chế độ trong cùng codebase**, chọn trước mỗi lượt/phiên và so sánh được bằng cùng bộ audio:

| Chế độ | Phát hiện dừng nói | Audio gửi tới STT | Dữ liệu gửi tới engine/LLM |
| --- | --- | --- | --- |
| `local_vad_batch` — hoãn | Model Silero chạy trong browser | Một blob hoàn chỉnh sau khi kết thúc thu | Một transcript đầy đủ của lượt |
| `elevenlabs_realtime` — ưu tiên, đã triển khai local | VAD của ElevenLabs, có bước chốt lượt ở ứng dụng | PCM gửi liên tục qua WebSocket | Một transcript đầy đủ sau khi kết thúc và drain stream |

**Bắt buộc:** không gọi engine/LLM từ audio chunk, transcript tạm hoặc callback từng đoạn STT. Một lượt có thể chứa nhiều câu và nhiều đoạn transcript; gom đủ lượt mới bàn giao.

LLM nhận **text đầy đủ**, không nhận các chunk audio. Tái sử dụng TTS, voice allowlist, ngôn ngữ phiên, playback và Stop hiện có. Engine nhân vật đã có cổng `EngineBridge`; không thay logic hoặc tạo thêm memory trong phần voice.

“Gọi một lần” ở đây là **một lần bàn giao lượt hoàn chỉnh cho `EngineBridge.prepare` hoặc GPT stub**. Số lời gọi model nội bộ của engine nằm ngoài phạm vi voice.

## 2. Định nghĩa kết thúc lượt

VAD biết có lời nói hay không, không bảo đảm hiểu người dùng đã nói hết ý. Chính sách tự động đề xuất là: đã xác nhận có lời, sau đó không còn lời liên tục **3.000 ms**. Người dùng nói tiếp trước thời hạn thì tiếp tục cùng lượt.

- Mốc 3 giây là đề xuất thử nghiệm, thay cho 1,5 giây của bản RMS; chưa phải thông số đã được benchmark.
- Ca nghỉ 800 ms và 2.200 ms phải giữ được cả hai mệnh đề.
- **Gửi ngay** xác nhận kết thúc thủ công; **Hủy/Stop** bỏ lượt.
- Nếu cần chắc chắn người dùng đã nói hết ý bất kể khoảng nghỉ dài bao nhiêu, dùng chế độ xác nhận bằng nút Gửi. Không dùng thêm LLM để đoán kết thúc câu.
- Giữ giới hạn audio **30 giây** theo contract. Nếu chạm giới hạn trong lúc vẫn nói, dừng và yêu cầu chia lượt; **không tự gửi một đoạn đang nói dở cho LLM**. Đây là thay đổi có chủ đích so với RMS hiện tại tự submit ở `max_duration`.

### Điểm chặn trước khi gọi engine

```text
idle → preparing → listening → end_candidate → finalizing → ready → processing → playback
                         ↑          │
                         └─ nói tiếp┘
bất kỳ trạng thái trước ready → canceled / error: không gọi engine
```

Chỉ chuyển `ready` khi đủ tất cả điều kiện:

1. Đã xác nhận lời nói hoặc người dùng bấm Gửi với audio hợp lệ.
2. Lượt được đóng bằng endpoint đã xác nhận hoặc Gửi thủ công; không phải do mất mạng, EOF hay hết hạn.
3. Đã nhận đủ audio cuối và kết quả STT cuối của lượt.
4. Transcript không rỗng, đúng giới hạn contract; session/config còn hợp lệ.
5. Lượt chưa bị hủy, chưa từng dispatch và không có lượt xử lý cạnh tranh.

Dùng cùng `turn_id/request_id`, trạng thái và generation để chặn double-click, finalize trùng, callback trễ, Stop đua với upload và đổi mode giữa lượt. HTTP retry cùng ID dùng cơ chế idempotency hiện có. Với realtime, finalize trùng bị từ chối/hủy; không reconnect/replay hoặc tạo một lần gọi engine mới. Khi không biết engine đã nhận sau lỗi kết nối/process restart, không tự gửi lại với ID mới hoặc hứa exactly-once xuyên crash.

## 3. Bản A — model VAD trong browser + STT batch, để sau

```text
Microphone dùng chung một MediaStream
  ├─ MediaRecorder: giữ toàn bộ audio của lượt
  └─ Silero VAD: phân loại từng frame, xác định khoảng không có lời
       → đủ điều kiện kết thúc → stop recorder → chờ dataavailable cuối + stop
       → POST turn chứa một blob hoàn chỉnh
       → STT batch → transcript đầy đủ → engine/GPT → TTS → playback
```

### Thiết kế

- Thêm detector interface để RMS và Silero là các adapter, tách khỏi MediaRecorder và lifecycle microphone.
- Dùng `@ricky0123/vad-web`/ONNX Runtime Web với phiên bản và asset được pin. Mốc thử đầu là Silero V5 vì đã kiểm tra artifact; đánh giá V6 ở spike trước khi pin bản cuối. Tài liệu package hiện khuyến nghị V6; không tự đổi model theo `latest`. [Models](https://docs.vad.ricky0123.com/user-guide/models/)
- Model đọc frame để ra quyết định; không ghép các đoạn `onSpeechEnd` thành audio upload. Recorder giữ cả khoảng nghỉ và mọi mệnh đề trong lượt.
- Cung cấp stream hiện có qua `getStream`. Quyền stop tracks thuộc capture owner: override lifecycle của thư viện để pause VAD không làm dừng recorder trước khi flush. Đặt `submitUserSpeechOnPause=false` để Hủy không trở thành Gửi. [VAD API](https://docs.vad.ricky0123.com/user-guide/api/)
- Dùng một chính sách im lặng 3 giây, không cộng thêm 3 giây sau khi thư viện đã chờ đủ `redemptionMs`.
- Lazy-load model khi chuẩn bị mic; host asset theo build của app, cache theo phiên bản. Đóng/hide trang, Hủy và đổi chế độ phải giải phóng stream, audio graph, worker và inference session.
- Không tải được model thì báo rõ và cho dùng Gửi thủ công hoặc chọn chế độ khác; không âm thầm đổi sang RMS.
- Bản A giữ cách upload MIME thật hiện tại: MP4/AAC cho Safari khi hỗ trợ, WebM/Opus khi phù hợp. VAD có thể resample để phân loại, nhưng blob gửi batch không bị ép đổi sang PCM.

### Tham số client đề xuất để thử

Đây là cấu hình thử của dự án, không phải toàn bộ default của thư viện. Silero dùng xác suất có lời và frame 16 kHz; ngưỡng này khác dBFS của RMS. [Thuật toán](https://docs.vad.ricky0123.com/user-guide/algorithm/)

| Tham số | Đề xuất đầu | Mục đích |
| --- | --- | --- |
| `positiveSpeechThreshold` | `0.30` | Bắt đầu xác nhận có lời |
| `negativeSpeechThreshold` | `0.25` | Xác nhận không có lời |
| `redemptionMs` | `3000` | Thời gian không có lời trước endpoint |
| `minSpeechMs` | `200` | Thử cả câu trả lời ngắn như “ừ”, “yes” |
| `preSpeechPadMs` | `300` | Ngữ cảnh trước lời cho detector; không cắt đầu blob recorder |
| Initial no-speech timeout | `5000 ms` sau khi sẵn sàng | Hủy khi không có tín hiệu |
| Maximum recording | `30000 ms` | Không vượt contract |
| Mic | mono, echo cancellation/noise suppression ưu tiên bật; AGC ưu tiên tắt | Giữ yêu cầu mic hiện tại, ghi nhận settings browser thực sự áp dụng |

Các ngưỡng cần tune bằng giọng nhỏ và noise-only; không hạ ngưỡng chỉ để mọi fixture đều được gửi.

## 4. Bản B — ElevenLabs realtime STT, gom đủ lượt rồi gọi engine

```text
Microphone → AudioWorklet → resample mono PCM16/16 kHz
  → WebSocket cùng origin tới backend Miu
  → backend relay tới ElevenLabs scribe_v2_realtime
  → partial: chỉ dùng hiển thị tạm
  → committed segments: lưu buffer trong lượt
  → xác nhận đóng lượt + flush/drain kết quả cuối
  → full transcript → TurnService → engine/GPT → TTS → playback
```

### Phân chia trách nhiệm

- Browser chỉ thu/encode PCM, stream và nhận trạng thái. Bản B không tải model VAD local.
- Backend sở hữu kết nối ElevenLabs và buffer transcript; API key không vào browser. Backend relay thêm một chặng mạng nhưng dùng được session/auth hiện có và giữ nguồn transcript ở server. [Server-side streaming](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/server-side-streaming)
- Một stream phục vụ một lượt; đóng sau khi finalize hoặc hủy. Không giữ mic/socket mở trong lúc TTS phát.
- Không gửi blob WebM/MP4 của MediaRecorder vào endpoint PCM. Resample liên tục có giữ state, không cắt độc lập từng block gây mất mẫu hoặc click.

### Xử lý transcript và điểm cuối

`committed_transcript` chỉ là kết quả ổn định của **một segment**; một session có thể có nhiều segment. `partial_transcript` mới thay bản partial cũ, không append mọi revision. Không nối trùng event có timestamps với event text, và không deduplicate chỉ bằng text vì người dùng có thể thực sự lặp lại câu. API không có event riêng tên `final_transcript`. [Event reference](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference)

Quy trình dự kiến:

1. Dùng `commit_strategy=vad`, khoảng im lặng provider 3 giây. Khi có committed segment, cập nhật buffer; callback này không được gọi engine.
2. Coordinator xem đây là **ứng viên đóng lượt**, phải phân biệt commit do VAD với segment/commit khác bằng hành vi đã xác minh ở spike. Không suy ra kết thúc từ dấu chấm trong text hoặc từ việc không nhận được partial.
3. Yêu cầu browser dừng và flush nốt PCM với `last_seq`; backend xác nhận nhận đủ các chunk đúng thứ tự. Nếu có lời/transcript mới trước khi đóng lượt, hủy ứng viên hoặc hủy lần finalize cũ để không gửi text thiếu.
4. Drain provider đến khi đã xác nhận đủ transcript của audio cuối. Backend nhận đủ chunk chưa đồng nghĩa provider đã xử lý đủ. Manual commit nếu cần phải được chứng minh hoạt động trong VAD mode; không giả định đóng WebSocket sẽ tự flush.
5. Khi buffer đã ổn định và lượt được chốt, freeze full transcript, phát `transcript.final` của **ứng dụng** và cho phép finalize turn.
6. Chỉ sau đó TurnService nhận text hoàn chỉnh, bỏ bước STT batch và bàn giao cho engine/GPT.

**P0 đã xác minh:** probe thật nhận VAD commit giữ đủ hai mệnh đề cách nhau 2,2 giây; manual commit cuối trong VAD mode trả acknowledgement, kể cả text rỗng khi chỉ còn silence. Triển khai dựa vào handshake/drain này và từ chối timeout, không suy ra đã xong từ socket close. Public API vẫn không có event `final_transcript`; `transcript.final` là event do Miu tạo sau drain.

VAD provider có khoảng chờ tối đa 3 giây theo tài liệu hiện tại. Muốn chờ lâu hơn cần lớp gom lượt riêng hoặc xác nhận thủ công; không đặt giá trị ngoài range rồi kỳ vọng provider hỗ trợ. [Commit strategies](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies)

### Tham số ElevenLabs đề xuất

| Vị trí | Tham số | Giá trị thử |
| --- | --- | --- |
| URL | endpoint | `wss://api.elevenlabs.io/v1/speech-to-text/realtime` |
| Header server-side | `xi-api-key` | Khóa chỉ đọc từ env backend |
| Query | `model_id` | `scribe_v2_realtime` |
| Query | `audio_format` | `pcm_16000` |
| Query | `language_code` | `vi` hoặc `en` theo phiên |
| Query | `commit_strategy` | `vad` |
| Query | `vad_silence_threshold_secs` | `3.0` |
| Query | `vad_threshold` | Không gửi; dùng mặc định theo chế độ lọc nền (probe hiện `0.15`) |
| Query | `min_speech_duration_ms` | Không gửi, provider mặc định |
| Query | `min_silence_duration_ms` | Không gửi, provider mặc định |
| Query | `include_timestamps` / `include_language_detection` | `false` ban đầu |
| Query | `filter_background_audio` | **`true` theo lựa chọn đã chốt** |
| Query | `no_verbatim` | `false` để giữ tương thích batch hiện tại |
| Query | `enable_logging` | Normal mode thì bỏ query theo lựa chọn brain; không fallback privacy khi lỗi |
| Message | `message_type` | `input_audio_chunk` |
| Message | `audio_base_64` / `sample_rate` | PCM16 little-endian / `16000` |
| Message | `commit` | Không commit từng chunk; chỉ dùng khi đã xác minh flush/manual finalize |

Mapping đã được kiểm tra qua `session_started` và probe thật; giữ các ngưỡng sensitivity/duration còn lại theo mặc định provider. [Realtime API](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)

Đề xuất gửi chunk **200 ms**: 6.400 byte PCM trước base64. Đây là giá trị của dự án, trong khoảng chunk được nhà cung cấp hướng dẫn. Tiếp tục gửi silence PCM khi đang chờ VAD, không ngừng stream ngay khi âm nhỏ. `filter_background_audio` cần test riêng về sensitivity và tương thích timestamps. [Commit/audio guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies)

### Contract ứng dụng đề xuất

Contract triển khai đã thu gọn về **một WebSocket/lượt**, không cần REST create/finalize bổ sung:

- `GET /api/voice/capabilities`: frontend chọn đúng mode backend đang chạy.
- `WSS /api/sessions/{session_id}/speech-stream`: `stream.start` đầu tiên chứa token và `request_id`, xác thực trước khi mở upstream và tạo reservation. Không đặt token/key trong URL.
- PCM binary có sequence; `audio.end(last_seq)` là yêu cầu finalize. Server kiểm tra frame, tổng byte/duration và backpressure; không drop chunk âm thầm.
- Server trả `stream.ready`, `transcript.partial`, `transcript.segment`, `turn.end_candidate`, `stream.drained`, `transcript.final`, `stream.processing`, `turn.result`, `stream.error`. Đây là event ứng dụng.
- Sau drain, server truyền full transcript nội bộ tới TurnService và trả envelope hiện có với `input_mode=realtime_stt`. Browser không tự gửi text quay lại để thay buffer server, không dùng `textOnly=true`.
- Chỉ một reservation/turn active trên profile. Hủy, session đóng và snapshot thay đổi abort stream; config/chuyển ngày cạnh tranh bị chặn.

Buffer tạm có TTL và xóa sau kết thúc/hủy. Không tự reconnect rồi replay audio hoặc gửi lại transcript đã dispatch, vì có thể tạo câu trả lời trùng. Người dùng chủ động bắt đầu lại khi mất stream.

## 5. Cấu hình đã hỗ trợ

| Biến env | Giá trị / ý nghĩa |
| --- | --- |
| `VOICE_INPUT_MODE` | `elevenlabs_realtime` khi real; `rms_batch` để dùng bản cũ. Fake mode chỉ dùng bản cũ |
| `ELEVENLABS_VAD_SILENCE_MS` | `3000`, giới hạn 192–3000 ms theo WS API |
| `STT_LOGGING` | `1` theo brain; không tự fallback privacy khi provider từ chối |
| `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` | Backend đọc từ env, không đưa vào `VITE_*` |

Model realtime là `scribe_v2_realtime`, filter luôn bật; sensitivity/duration khác không gửi để dùng mặc định provider. Deadlines hiện có: kết nối 10 giây, không có text 8 giây, thu 30 giây, drain 10 giây. Frame 200 ms, PCM mono 16 kHz. Local VAD chưa có config runtime.

Mode snapshot trong session client và reservation backend, không thêm trường vào config personality/memory. Xem [guide runtime](elevenlabs-realtime.md) để biết mapping đầy đủ.

## 6. Module dự kiến

Tên file là đề xuất; giữ Express + TypeScript và composition root hiện có.

| Vị trí | Thay đổi |
| --- | --- |
| `packages/voice-client/src/capture.ts` | Tách capture owner và detector adapter, giữ nguyên quyền quản lý mic/recorder |
| `packages/voice-client/src/detectors/` | Interface, RMS adapter và Silero adapter |
| `packages/voice-client/src/turn-endpoint.ts` | State machine kết thúc lượt, manual send/cancel, giới hạn và generation |
| `packages/voice-client/src/realtime/` | AudioWorklet, stateful resampler/PCM encoder và WebSocket transport |
| `packages/voice-client/src/controller.ts` | Strategy cho hai mode, chung lifecycle và playback |
| `backend/pipeline/src/modules/speech-streams/` | Controller/routes/service/repository tạm, transcript buffer và finalize |
| `backend/pipeline/src/providers/elevenlabs/realtime-stt.provider.ts` | Kết nối upstream, normalize event, commit/drain/error mapping |
| `backend/pipeline/src/modules/turns/` | Nhận transcript đã hoàn chỉnh qua đường nội bộ; tiếp tục dùng engine/TTS hiện có |
| `backend/pipeline/src/server-runtime.ts`, `backend/integration/server.ts` | Gắn WS upgrade vào đúng HTTP server, lifecycle shutdown cho cả standalone và integrated |
| `packages/voice-contracts`, `docs/api-contracts.md` | Mode/capabilities, stream protocol, nguồn transcript và finalization |
| `frontend/src/lib/usePipelineVoice.ts`, `Talk.tsx` | Handoff selector ở phần cài đặt/demo, trạng thái chuẩn bị/thu/chốt/xử lý; frontend phụ trách UI responsive |
| `deploy/miu/` | Asset model/WASM/worklet và WS proxy trên virtual host Miu |

Không tạo backend thứ hai hoặc fork hai bộ TurnService/engine/TTS. Có thể giữ RMS làm chế độ cũ để rollback, nhưng UI phải báo đúng chế độ đang chạy.

## 7. Thứ tự triển khai và tiêu chí xong

| Bước | Công việc | Điều kiện hoàn thành |
| --- | --- | --- |
| **P0: xác minh** | Pin package/asset VAD; kiểm tra Safari; thử protocol realtime, pause/resume/commit/drain và quyền key | Chốt được cách lấy đủ transcript cuối, không dựa vào event tưởng tượng; ghi rõ trường hợp bị chặn |
| **P1: contract + nền chung** | Mode, reservation, endpoint state machine, idempotency/cancel, test chặn gọi engine sớm | Audio/partial/segment không thể chạm engine trước `ready` |
| **P2: bản B — làm trước, đã có** | PCM worklet/resample, WS relay, transcript buffer, drain và finalize | Có nhiều partial/segment nhưng chỉ một dispatch với full text; không gọi STT batch lại |
| **P3: bản A — hoãn** | Silero adapter + shared stream + MediaRecorder flush + asset build | Chỉ bắt đầu sau khi quay lại yêu cầu local VAD model |
| **P4: UI + kiểm thử** | Selector demo, trạng thái và lỗi; so sánh hai mode bằng audio thật/iPad | Có báo cáo chất lượng endpoint, transcript và latency riêng từng mode |
| **P5: phát hành** | Build asset, kiểm tra proxy WS, rollout từng mode có rollback | Chỉ sửa service/vhost Miu; HTTPS, WS, desktop và iPad qua acceptance |

Logging đã được giải quyết tường minh trước real test: bỏ alias `false` ở `.env` local, chọn `STT_LOGGING=1` theo brain và đồng bộ default của entrypoint tích hợp từ `0` thành `1`. Vẫn giữ explicit `0` khi người dùng chủ động yêu cầu; không tự chuyển sang normal sau lỗi hoặc warning retention.

P5 cần thêm WS upgrade/proxy timeout, giới hạn kết nối và đóng WS khi service shutdown; `closeAllConnections()` hiện tại không thay cho quản lý lifecycle WebSocket. Không cần webhook mới.

## 8. Kiểm thử và tiêu chí bàn giao

Baseline đã có: [kết quả 20 audio](../../test-assets/voice-pipeline/TEST-RESULTS.md). Không chạy lại API chỉ để lập plan này.

| Nhóm | Điều cần chứng minh |
| --- | --- |
| Gate gọi engine | 0 lần khi đang nói, partial, segment chưa chốt, Hủy, timeout hoặc stream lỗi; 1 dispatch sau khi chốt toàn lượt |
| Transcript | Partial revision không lặp chữ; nhiều committed segment được gom đúng; đoạn lặp có chủ ý không bị xóa; metadata/timestamps không append lại text |
| Điểm cuối | Nghỉ 800/2.200 ms giữ đủ hai mệnh đề; nghỉ vượt cấu hình và tiếp tục nói được ghi nhận là ranh giới lượt, không tuyên bố hiểu hết ý |
| Audio cuối | Chữ cuối ở chunk cuối không mất; chunk delayed/thiếu/thừa/out-of-order, commit trùng, drain timeout đều không tạo full transcript giả |
| Tiếng nhỏ/nhiễu | Chạy đủ 20 file, bổ sung “ừ/yes”, mic bật khi đã bắt đầu nói, nhiễu bật đột ngột; ghi nhận bỏ sót và false trigger |
| Giới hạn | Đang nói khi chạm 30 giây thì không gửi câu dở; audio/queue/frame quá lớn bị chặn; cleanup sau lỗi |
| Lifecycle | Hủy lúc đang chốt, đổi mode/config, hide tab, khóa iPad, mất mạng, reconnect, double finalize, response đến muộn |
| Tích hợp | Cùng contract trả lời, voice/language/TTS/playback receipts; engine nhận full text, không thay đổi memory behavior |

Với file chỉ có đuôi nền 2 giây, replay cần thêm phần nền cùng điều kiện cho đủ mốc 3 giây; ghi rõ phần bổ sung trong report, không dùng EOF như endpoint hoặc thêm digital silence để làm đẹp ca nhiễu. Không kéo dài ca đã chạm giới hạn 30 giây.

Đánh giá endpoint có thể chạy offline; kết luận STT/engine/TTS phải dùng provider thật theo [AGENTS.md](../../AGENTS.md). Khi chưa gọi được real provider thì ghi blocker, không thay bằng fake rồi tính pass.

Đo riêng: model load lạnh/ấm, bộ nhớ/CPU trên iPad, frame processing, thời gian chờ sau lời cuối, STT final/drain, engine, TTS và audio đầu tiên. Chỉ công bố p95 khi có đủ lượt thực; không gộp thời gian chờ 3 giây vào “STT chậm”. So sánh hai mode trên cùng device, audio, ngôn ngữ, voice và network.

Các lựa chọn và cập nhật đã chốt: [speech-input-decisions.md](speech-input-decisions.md). Chưa commit/push/deploy lần triển khai này.

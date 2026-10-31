# Trạng thái triển khai voice v1

Ngày cập nhật: **31/10/2026**. Backend và browser library đã có; frontend của nhóm đã tích hợp và triển khai. Probe riêng STT → GPT → TTS thật cho Việt/Anh đã qua trên máy phát triển và server. Chưa benchmark p95 hoặc kiểm thử microphone/playback trên iPad thật; memory và character engine vẫn ngoài voice stub.

| Hạng mục | Đã làm | Kiểm tra |
| --- | --- | --- |
| Backend Express 5/TypeScript | Routers/controllers, TurnService, SessionService/repository RAM, middleware HTTP và provider adapters; giữ canonical session/config/turn/cancel/receipt | HTTP integration tests, fake bilingual smoke; xem [kiến trúc](backend-architecture.md) |
| STT | ElevenLabs Scribe v2 batch, container nguyên bản, ngôn ngữ phiên; normal mode theo brain | Mock HTTP kiểm tra payload/bytes/lỗi/cancellation/logging; probe thật Việt/Anh |
| GPT tạm | Responses SDK, gpt-6-luna, effort none, store false, chỉ transcript hiện tại | Mock stateless request/incomplete/refusal/format/length; probe thật Việt/Anh |
| TTS | Flash v2.5, 5 voice trong allowlist, MP3, output text gate; không gửi logging query | Mock payload/voice-language/audio; probe thật Việt/Anh dùng default voice, MP3 hợp lệ |
| Audio validation | WAV PCM, MP4/AAC, WebM/Opus; kiểm tra MP3 đầu ra; ffprobe có timeout/hủy | Fixture tổng hợp, metadata cuối MP4, WebM chưa có duration, sai MIME/corrupt/limit |
| Browser library | RMS thích nghi, recorder+meter cùng stream, API client, player và controller không UI | Detector với clock giả; lifecycle gửi/hủy/chunk cuối, stale output và playback |
| Fake path | Hai sample WAV Việt/Anh từ repo local tham chiếu; fixture ID bắt buộc | Smoke từ tạo phiên đến playback receipt, không key/network provider |
| Bàn giao | Types chung, cách thay ResponseGenerator, env example và README cho frontend | Build/typecheck và hướng dẫn chạy |

Lệnh từ root: `npm ci`, `npm run build`, `npm test`, `npm run smoke`, `npm run dev`. Chi tiết: [backend README](../../backend/pipeline/README.md), [browser client README](../../packages/voice-client/README.md).

Kiểm tra sau khi đồng bộ logging theo brain: build/typecheck qua; **139 test trong 13 file** qua; smoke Việt/Anh qua toàn bộ HTTP lifecycle/receipt bằng fake provider. Có HTTP localhost và TCP chunked thật để kiểm tra abort/giới hạn upload, cùng các bài mock browser và provider. Tests mới bao phủ default/blank/`1|0`, alias tương thích, cờ mâu thuẫn, real mode cần key và việc cờ STT không ảnh hưởng TTS.

Đã chạy entry point đã biên dịch `backend/pipeline/dist/server.js` trong process con: health HTTP 200, catalog đủ 5 voice, lượt Việt/Anh qua fake provider, rồi đóng process sạch. Các kiểm tra này xác nhận HTTP/runtime và wiring; chưa thay thế kiểm thử API hoặc thiết bị thật.

Template và chế độ mặc định vẫn là `MIU_PROVIDER=fake`; real mode cần `ELEVENLABS_API_KEY` và `OPENAI_API_KEY`. `STT_LOGGING=1` mặc định khớp brain: STT bỏ query `enable_logging`, TTS cũng không gửi query này. Cờ `0` chỉ yêu cầu ZRM cho STT và hiện nhận 403; backend không tự chuyển sang normal mode khi lỗi. Alias cũ `ELEVENLABS_ENABLE_LOGGING=true|false` chỉ điều khiển STT; đặt hai cờ khác nhau bị từ chối. Ứng dụng không tự ghi đè `.env`.

Đã đối chiếu cấu hình local `brain/.env` (`STT_LOGGING=1`), `brain/config.js`, `brain/speech/stt.js:44` và `brain/speech/tts.js`. Chỉ đồng bộ hành vi logging: Scribe v2, Flash v2.5/MP3 và GPT không memory vẫn giữ theo quyết định của project này. Probe cùng key/payload cho STT normal HTTP 200; ZRM HTTP 403 `not_allowed`, yêu cầu enterprise hoặc trial tier. Vì vậy lỗi này không phải microphone bị chặn hoặc toàn bộ STT bị hạn chế; tier/thời hạn retention cụ thể vẫn chưa xác minh.

Probe riêng trên dữ liệu hư cấu/reference đã chạy toàn luồng real STT → GPT → TTS và kiểm tra MP3 hợp lệ:

| Nơi chạy | Tiếng Việt | Tiếng Anh | Phạm vi |
| --- | --- | --- | --- |
| Máy phát triển | Tổng 4.729 ms; MP3 81.963 bytes, dài 5.094 ms | Tổng 2.738 ms; MP3 106.622 bytes, dài 6.635 ms | Transcript và reply không rỗng, audio/mpeg; mỗi tiếng một lượt |
| Server, process kiểm tra cô lập | Tổng 2.776 ms | Tổng 2.481 ms | Dùng provider thật; không đưa keys vào báo cáo; mỗi tiếng một lượt |

Đây là thời gian xử lý server của các lượt đơn lẻ, không gồm microphone/endpointing/upload/playback thực tế và không phải median/p95. Chưa xác nhận toàn bộ 5 voice trong allowlist. Mode public hiện tại nằm ở trường `provider_mode` của [`/api/health`](https://miu.curiopal.com/api/health); cấu hình real dùng `MIU_PROVIDER=real`, `STT_LOGGING=1` theo [hướng dẫn deploy](../../deploy/miu/README.md).

`engine_mode=voice_stub` trả `presentation/face/memory=null`, receipt learning disabled. Các cấu hình MBTI/role chỉ được validate/lưu cấu hình cho engine sau; chưa giả vờ đã có logic personality hoặc memory. Cache kết quả/idempotency là dữ liệu giao thức ngắn hạn, không tạo history cho GPT.

Fake mode dùng reference voice sample nói **Buddy**, đúng transcript khai báo của sample, để kiểm tra đường audio. Đây không phải câu trả lời Miu do model sinh hoặc nhận dạng offline. UI kiểm thử cần hiển thị mode; real adapter có prompt Miu. Nguồn fixture tại [fixtures README](../../backend/pipeline/fixtures/README.md).

Bổ sung theo yêu cầu tạo audio kiểm thử: [20 WAV đầu vào](../../test-assets/voice-pipeline/README.md) gồm 10 Việt/10 Anh, giọng tổng hợp mô phỏng trẻ em và các biến thể âm học. Riêng job tạo bộ này đã gọi ElevenLabs TTS thật cho 6 đoạn hư cấu (196 ký tự), rồi tạo nhiễu/biến đổi offline; job tạo corpus không phải kiểm thử microphone/iPad. Probe real pipeline nêu trên là lần kiểm tra riêng, không có nghĩa đã chạy cả 20 file hoặc đo chất lượng bộ corpus. Kết quả detector trên waveform và giới hạn dữ liệu ghi ở README/validation của bộ audio.

Trước demo thật: frontend tích hợp library, kiểm tra trusted HTTPS, mic permission, định dạng actual MIME, auto-end 1.500ms, Gửi/Stop, autoplay và đổi tab/khóa màn hình trên iPad. Đo p95≤5s từ kết thúc thu trên mạng/thực tế, báo cold start và lỗi; kết quả fake/mocked tests không chứng minh mục tiêu này. Full safety/character validation và production authentication vẫn ngoài phạm vi voice v1.

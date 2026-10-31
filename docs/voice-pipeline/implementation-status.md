# Trạng thái triển khai voice v1

Ngày cập nhật: **31/10/2026**. Code đã có, chưa benchmark provider hoặc kiểm thử microphone trên iPad thật. Không triển khai UI sản phẩm, memory hoặc character engine của người khác.

| Hạng mục | Đã làm | Kiểm tra |
| --- | --- | --- |
| Backend Express 5/TypeScript | Routers/controllers, TurnService, SessionService/repository RAM, middleware HTTP và provider adapters; giữ canonical session/config/turn/cancel/receipt | HTTP integration tests, fake bilingual smoke; xem [kiến trúc](backend-architecture.md) |
| STT | ElevenLabs Scribe v2 batch, container nguyên bản, ngôn ngữ phiên | Mock HTTP kiểm tra payload, bytes, lỗi và cancellation |
| GPT tạm | Responses SDK, gpt-6-luna, effort none, store false, chỉ transcript hiện tại | Mock stateless request, incomplete/refusal/format/length |
| TTS | Flash v2.5, 5 voice trong allowlist, MP3, output text gate | Mock payload, voice-language match, audio MIME/size/duration |
| Audio validation | WAV PCM, MP4/AAC, WebM/Opus; kiểm tra MP3 đầu ra; ffprobe có timeout/hủy | Fixture tổng hợp, metadata cuối MP4, WebM chưa có duration, sai MIME/corrupt/limit |
| Browser library | RMS thích nghi, recorder+meter cùng stream, API client, player và controller không UI | Detector với clock giả; lifecycle gửi/hủy/chunk cuối, stale output và playback |
| Fake path | Hai sample WAV Việt/Anh từ repo local tham chiếu; fixture ID bắt buộc | Smoke từ tạo phiên đến playback receipt, không key/network provider |
| Bàn giao | Types chung, cách thay ResponseGenerator, env example và README cho frontend | Build/typecheck và hướng dẫn chạy |

Lệnh từ root: `npm ci`, `npm run build`, `npm test`, `npm run smoke`, `npm run dev`. Chi tiết: [backend README](../../backend/pipeline/README.md), [browser client README](../../packages/voice-client/README.md).

Kiểm tra sau khi chuyển Express: build/typecheck qua; **111 test trong 11 file** qua; smoke Việt/Anh qua toàn bộ HTTP lifecycle/receipt bằng fake provider. Có HTTP localhost và TCP chunked thật để kiểm tra abort/giới hạn upload, cùng các bài mock browser và provider.

Đã chạy entry point đã biên dịch `backend/pipeline/dist/server.js` trong process con: health HTTP 200, catalog đủ 5 voice, lượt Việt/Anh qua fake provider, rồi đóng process sạch. Các kiểm tra này xác nhận HTTP/runtime và wiring; chưa thay thế kiểm thử API hoặc thiết bị thật.

Chế độ mặc định `MIU_PROVIDER=fake`. File env thật không bị ghi đè. Real mode cần keys và lựa chọn `ELEVENLABS_ENABLE_LOGGING` rõ ràng sau khi xử lý D10; false không tự chứng minh quyền zero retention. Các test phần mềm dùng fake/mocked provider; job TTS riêng tạo corpus đầu vào được ghi ở dưới.

`engine_mode=voice_stub` trả `presentation/face/memory=null`, receipt learning disabled. Các cấu hình MBTI/role chỉ được validate/lưu cấu hình cho engine sau; chưa giả vờ đã có logic personality hoặc memory. Cache kết quả/idempotency là dữ liệu giao thức ngắn hạn, không tạo history cho GPT.

Fake mode dùng reference voice sample nói **Buddy**, đúng transcript khai báo của sample, để kiểm tra đường audio. Đây không phải câu trả lời Miu do model sinh hoặc nhận dạng offline. UI kiểm thử cần hiển thị mode; real adapter có prompt Miu. Nguồn fixture tại [fixtures README](../../backend/pipeline/fixtures/README.md).

Bổ sung theo yêu cầu tạo audio kiểm thử: [20 WAV đầu vào](../../test-assets/voice-pipeline/README.md) gồm 10 Việt/10 Anh, giọng tổng hợp mô phỏng trẻ em và các biến thể âm học. Riêng job tạo bộ này đã gọi ElevenLabs TTS thật cho 6 đoạn hư cấu (196 ký tự), rồi tạo nhiễu/biến đổi offline; đây chưa phải chạy real STT → GPT → TTS hoặc kiểm thử microphone/iPad. Không thay đổi fake mode hay `.env` của ứng dụng. Kết quả detector trên waveform và giới hạn dữ liệu ghi ở README/validation của bộ audio.

Trước demo thật: frontend tích hợp library, kiểm tra trusted HTTPS, mic permission, định dạng actual MIME, auto-end 1.500ms, Gửi/Stop, autoplay và đổi tab/khóa màn hình trên iPad. Đo p95≤5s từ kết thúc thu trên mạng/thực tế, báo cold start và lỗi; kết quả fake/mocked tests không chứng minh mục tiêu này. Full safety/character validation và production authentication vẫn ngoài phạm vi voice v1.

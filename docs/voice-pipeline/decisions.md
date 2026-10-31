# Quyết định triển khai voice pipeline

Cập nhật theo câu trả lời của bạn ngày **31/10/2026**, yêu cầu dùng Express + TypeScript và yêu cầu dùng cách cấu hình STT đang hoạt động của LittleBuddy brain. Các lựa chọn đã xác nhận là cơ sở triển khai, không cần trả lời lại. D08 đã bổ sung từ repo tham chiếu; ngoài fake/mocked tests, đã có probe STT → GPT → TTS thật cho Việt/Anh. Chưa nghiệm thu microphone/playback iPad hoặc p95.

## Các quyết định đã chốt

| Mã | Quyết định | Hệ quả triển khai |
| --- | --- | --- |
| D01 | ElevenLabs cho cả STT và TTS | Scribe v2 batch nhận audio nguyên bản; Flash v2.5 đọc câu trả lời; voice ID ở D08 |
| D02 | A — React + TypeScript; backend Express 5 + TypeScript theo yêu cầu mới | Giữ Node.js runtime; Express routers/controllers tách khỏi services/repository/providers theo [kiến trúc backend](backend-architecture.md); giao diện React/TS do thành viên frontend phụ trách |
| D03 | Chỉ batch | Thu xong mới upload; không triển khai realtime STT |
| D04 | Cách số 4 — ngưỡng âm lượng thích nghi | Web Audio đo RMS/nền; MediaRecorder ghi; tự gửi khi mức âm thấp đủ lâu; Gửi thủ công dự phòng |
| D05 | A — cân bằng | Im lặng 1.500 ms; chờ tín hiệu ban đầu 5.000 ms sau đo nền; thu tối đa 30.000 ms tính từ lúc recorder bắt đầu |
| D06 | Demo web trên iPad, responsive | Safari/iPadOS là môi trường kiểm thử chính dự kiến; frontend phụ trách layout, touch, portrait/landscape và split view; phần voice cung cấp contract/lifecycle để tích hợp |
| D07 | B — chọn Việt/Anh trước mỗi phiên | Lưu cấu hình phiên `vi` hoặc `en`; STT, GPT và TTS cùng dùng tiếng đã chọn; chưa tự chuyển ngôn ngữ trong v1 |
| D08 | Kế thừa voice đã chọn trong little-buddy-impl | Allowlist 5 ID; mặc định Việt Phan Anh, Anh Little Dude II; chi tiết và nguồn tại [voices.md](voices.md) |
| D09 | A — GPT đơn giản qua OpenAI API | `gpt-6-luna`, reasoning `none`, tối đa 200 output token; chỉ transcript hiện tại, không conversation/history/memory |
| D10 | C ban đầu — chưa biết gói/quyền retention; nay dùng normal mode theo LittleBuddy brain theo yêu cầu của bạn | `STT_LOGGING=1` mặc định, không gửi logging query cho STT/TTS. STT normal đã trả 200; STT ZRM (`0`) trả 403 trên tài khoản hiện tại. Không tuyên bố zero retention; GPT vẫn không memory |
| D11 | B — ưu tiên latency trong phạm vi batch | Một request turn; reuse kết nối provider khi có thể, payload gọn, trả lời ngắn, đo từng stage; không thêm VAD model/Isolation/realtime/streaming |
| D12 | Theo API contract, có thể bổ sung nếu cần | Dùng endpoint/session/config/cancel/playback chung; bỏ phương án ba route STT/reply/TTS public riêng |

Đây là quyết định thiết kế, không xác nhận quyền model, chất lượng giọng, độ trễ hoặc tính tương thích đã được đo trên iPad thật.

## D08 — Voice đã lấy từ little-buddy-impl

Đã đọc trực tiếp `D:/Intern/LittleBuddy_Implementation`: 5 ID cùng nhãn/ngôn ngữ/default nằm ở migration local và khớp `DEFAULT_VOICES` trong test helper; các file env không khai báo voice ID. Khởi điểm v1 dùng Việt **Phan Anh `mgBpvrNosWzExdPuRbXP`** và Anh **Little Dude II `fBD19tfE58bkETeiwUoC`**. Ba ID thay thế, nguồn local và ví dụ env ở [voices.md](voices.md). Không còn cần hỏi lại mã voice; quyền dùng voice trên tài khoản hiện tại vẫn cần xác minh khi kiểm thử thật.

Đề xuất giữ để nghe thử: `eleven_flash_v2_5`, speed `0.95`, stability `0.50`, similarity `0.75`, style `0`, speaker boost `false`. Một voice cho hai tiếng giúp giữ nhận diện Miu nhưng phải nghe thử cả hai. Chưa tự chọn một ID ví dụ của provider làm giọng chính thức.

## D10 — Logging theo LittleBuddy brain

Đã đối chiếu bản local `D:/Intern/LittleBuddy_Implementation/brain`: `.env` chọn `STT_LOGGING=1`, `config.js` mặc định bật trừ khi giá trị là `0`, và `speech/stt.js:44` chỉ thêm `?enable_logging=false` khi logging tắt. `speech/tts.js` không gửi logging query. Pipeline này dùng cùng hành vi; giữ Scribe v2, Flash v2.5/MP3 và GPT tạm không memory đã chọn, không sao chép model/format hoặc tính năng memory của brain.

`enable_logging=false` yêu cầu **zero-retention mode (ZRM)** của ElevenLabs, không phải tắt console log ở máy mình. Cùng key và payload STT đã được kiểm tra: normal mode HTTP 200, còn ZRM HTTP 403 `not_allowed`, thông báo tài khoản phải thuộc enterprise hoặc trial để dùng ZRM. Tài liệu API mô tả quyền zero retention riêng; lỗi này không có nghĩa microphone bị chặn hoặc mọi STT đều cần Enterprise. [ElevenLabs STT API](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)

`STT_LOGGING` nhận `1|0`; bỏ trống mặc định `1`. Alias cũ `ELEVENLABS_ENABLE_LOGGING=true|false` chỉ áp dụng STT; đặt cả hai khác nhau sẽ báo lỗi cấu hình. TTS không bị đổi khi bật/tắt cờ STT. Nếu chủ động chọn `0`, backend giữ lựa chọn đó và trả lỗi provider, không tự thử lại bằng normal mode. Tài khoản/tier và thời hạn lưu cụ thể chưa được xác nhận; lựa chọn normal mode theo yêu cầu hiện tại không phải cam kết zero retention.

## Thông tin còn cần bổ sung khi có

| Mục | Vì sao cần | Xử lý hiện tại |
| --- | --- | --- |
| Quyền dùng voice và nghe thử | Cần bảo đảm 5 ID kế thừa dùng được trên tài khoản/model hiện tại | Bộ ID/default đã có; fake mode vẫn dùng audio fixture |
| D10: tier/thời hạn retention cụ thể | Normal mode hoạt động; ZRM hiện bị 403, chưa xác nhận tier hoặc thời hạn lưu | Dùng `STT_LOGGING=1` theo brain và yêu cầu của bạn; không chặn real mode bằng yêu cầu chọn cờ lần nữa, không tuyên bố ZRM |
| Phiên bản iPadOS/browser, mic/loa, môi trường ồn | Capability MIME, DSP và mức âm thực khác nhau | Dùng Safari làm mục tiêu kiểm thử dự kiến, feature-detect và ghi phiên bản khi thử |
| Thiết bị iPad truy cập HTTPS thực tế | Mic cần secure context; HTTP qua IP LAN không được hưởng ngoại lệ localhost của máy phát triển | Frontend/API đã có `https://miu.curiopal.com`; cần kiểm thử trên iPad thật |
| Ngân sách, số người dùng đồng thời, local/nội bộ/public | Cần đặt quota/rate limit phù hợp trước khi chia sẻ | Chưa đăng ký gói, chưa chạy benchmark tính phí |
| Deadline và thời điểm engine sẵn sàng | Cần sắp thứ tự tích hợp | Xây theo các bước trong plan, GPT tạm thay được qua adapter |

Không cần bạn trả lời lại D01–D09, lựa chọn normal mode theo brain ở D10, mức ưu tiên D11 hoặc định hướng D12. Các thông tin còn thiếu được giữ ở đây để bổ sung khi có; real mode đã có kiểm tra provider riêng, còn nghiệm thu thiết bị/latency thực tế là bước tiếp theo.

## Những chi tiết kỹ thuật đã đồng bộ

- [API contracts](../api-contracts.md): dùng `POST /api/sessions/{session_id}/turns`; hỗ trợ MP4/AAC cho iPad cùng WebM/Opus và WAV; tối đa 30 giây/5 MiB audio, tổng multipart 6 MiB.
- D07 dùng cấu hình server `language_mode=vi|en`; `language_hint` chỉ gợi ý, không override cấu hình. Nếu đổi ngôn ngữ, kết thúc/đổi phiên theo lifecycle chung, không tự đổi giữa một lượt đang chạy.
- Thời gian 1.500/5.000/30.000 ms ở D05 đã chốt. Calibration 750 ms, margin 12/6 dB, min signal 120 ms, AGC ưu tiên tắt và bitrate 64 kbps vẫn là giá trị kỹ thuật khởi điểm để tune.
- D11 đo riêng thời gian chờ dưới ngưỡng, flush recorder, upload, STT, GPT, TTS, nhận response và bắt đầu phát. Mục tiêu tích hợp theo pipeline chung: p95 nghe câu trả lời đầu tiên ≤5 giây sau kết thúc thu, đo 30 câu ngắn mỗi ngôn ngữ/provider; không tuyên bố đã đạt.
- Frontend responsive thuộc người khác. Phần việc voice bàn giao input/output, cấu hình detector, trạng thái thu/phát/hủy, yêu cầu HTTPS/MIME và checklist iPad.
- Engine/memory chính thức vẫn do người khác làm. Adapter GPT tạm không truy xuất/lưu memory hoặc lịch sử hội thoại và không tự dựng các trường memory/character để giả lập tính năng đã có.

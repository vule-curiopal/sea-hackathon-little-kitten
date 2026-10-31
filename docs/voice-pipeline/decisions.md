# Quyết định triển khai voice pipeline

Cập nhật theo câu trả lời của bạn ngày **31/10/2026**. Các lựa chọn đã xác nhận là cơ sở triển khai, không cần trả lời lại. D08 đã bổ sung từ `little-buddy-impl`; chưa gọi API thật hoặc triển khai code.

## Các quyết định đã chốt

| Mã | Quyết định | Hệ quả triển khai |
| --- | --- | --- |
| D01 | ElevenLabs cho cả STT và TTS | Scribe v2 batch nhận audio nguyên bản; Flash v2.5 đọc câu trả lời; voice ID ở D08 |
| D02 | A — React + TypeScript, Node.js + TypeScript | Backend/provider adapters bằng Node.js/TS; giao diện React/TS do thành viên frontend phụ trách |
| D03 | Chỉ batch | Thu xong mới upload; không triển khai realtime STT |
| D04 | Cách số 4 — ngưỡng âm lượng thích nghi | Web Audio đo RMS/nền; MediaRecorder ghi; tự gửi khi mức âm thấp đủ lâu; Gửi thủ công dự phòng |
| D05 | A — cân bằng | Im lặng 1.500 ms; chờ tín hiệu ban đầu 5.000 ms sau đo nền; thu tối đa 30.000 ms tính từ lúc recorder bắt đầu |
| D06 | Demo web trên iPad, responsive | Safari/iPadOS là môi trường kiểm thử chính dự kiến; frontend phụ trách layout, touch, portrait/landscape và split view; phần voice cung cấp contract/lifecycle để tích hợp |
| D07 | B — chọn Việt/Anh trước mỗi phiên | Lưu cấu hình phiên `vi` hoặc `en`; STT, GPT và TTS cùng dùng tiếng đã chọn; chưa tự chuyển ngôn ngữ trong v1 |
| D08 | Kế thừa voice đã chọn trong little-buddy-impl | Allowlist 5 ID; mặc định Việt Phan Anh, Anh Little Dude II; chi tiết và nguồn tại [voices.md](voices.md) |
| D09 | A — GPT đơn giản qua OpenAI API | `gpt-6-luna`, reasoning `none`, tối đa 200 output token; chỉ transcript hiện tại, không conversation/history/memory |
| D10 | C — chưa biết gói/quyền retention | Cần xác minh tài khoản và chính sách trước khi cấu hình/gọi API thật; docs, khung, fake adapter và tích hợp contract vẫn làm được |
| D11 | B — ưu tiên latency trong phạm vi batch | Một request turn; reuse kết nối provider khi có thể, payload gọn, trả lời ngắn, đo từng stage; không thêm VAD model/Isolation/realtime/streaming |
| D12 | Theo API contract, có thể bổ sung nếu cần | Dùng endpoint/session/config/cancel/playback chung; bỏ phương án ba route STT/reply/TTS public riêng |

Đây là quyết định thiết kế, không xác nhận quyền model, chất lượng giọng, độ trễ hoặc tính tương thích đã được đo trên iPad thật.

## D08 — Voice đã lấy từ little-buddy-impl

Đã đọc trực tiếp `D:/Intern/LittleBuddy_Implementation`: 5 ID cùng nhãn/ngôn ngữ/default nằm ở migration local và khớp `DEFAULT_VOICES` trong test helper; các file env không khai báo voice ID. Khởi điểm v1 dùng Việt **Phan Anh `mgBpvrNosWzExdPuRbXP`** và Anh **Little Dude II `fBD19tfE58bkETeiwUoC`**. Ba ID thay thế, nguồn local và ví dụ env ở [voices.md](voices.md). Không còn cần hỏi lại mã voice; quyền dùng voice trên tài khoản hiện tại vẫn cần xác minh khi kiểm thử thật.

Đề xuất giữ để nghe thử: `eleven_flash_v2_5`, speed `0.95`, stability `0.50`, similarity `0.75`, style `0`, speaker boost `false`. Một voice cho hai tiếng giúp giữ nhận diện Miu nhưng phải nghe thử cả hai. Chưa tự chọn một ID ví dụ của provider làm giọng chính thức.

## Thông tin còn cần bổ sung khi có

| Mục | Vì sao cần | Xử lý hiện tại |
| --- | --- | --- |
| Quyền dùng voice và nghe thử | Cần bảo đảm 5 ID kế thừa dùng được trên tài khoản/model hiện tại | Bộ ID/default đã có; fake mode vẫn dùng audio fixture |
| D10: gói ElevenLabs/quyền retention | `enable_logging=false` không tự chứng minh provider không lưu | Chưa coi chính sách mặc định hoặc zero retention là đã được bạn duyệt; xác minh trước real mode |
| Phiên bản iPadOS/browser, mic/loa, môi trường ồn | Capability MIME, DSP và mức âm thực khác nhau | Dùng Safari làm mục tiêu kiểm thử dự kiến, feature-detect và ghi phiên bản khi thử |
| Địa chỉ HTTPS dùng trên iPad, nơi chạy backend | Mic cần secure context; HTTP qua IP LAN không được hưởng ngoại lệ localhost của máy phát triển | Node/TS là lựa chọn đã chốt, host/deploy còn mở; chuẩn bị một origin HTTPS được iPad tin cậy |
| Ngân sách, số người dùng đồng thời, local/nội bộ/public | Cần đặt quota/rate limit phù hợp trước khi chia sẻ | Chưa đăng ký gói, chưa chạy benchmark tính phí |
| Deadline và thời điểm engine sẵn sàng | Cần sắp thứ tự tích hợp | Xây theo các bước trong plan, GPT tạm thay được qua adapter |

Không cần bạn trả lời lại D01–D09, lựa chọn C của D10, mức ưu tiên D11 hoặc định hướng D12. Các thông tin còn thiếu được giữ ở đây để bổ sung một lượt sau; không chặn việc hoàn thiện docs/fake path.

## Những chi tiết kỹ thuật đã đồng bộ

- [API contracts](../api-contracts.md): dùng `POST /api/sessions/{session_id}/turns`; hỗ trợ MP4/AAC cho iPad cùng WebM/Opus và WAV; tối đa 30 giây/5 MiB audio, tổng multipart 6 MiB.
- D07 dùng cấu hình server `language_mode=vi|en`; `language_hint` chỉ gợi ý, không override cấu hình. Nếu đổi ngôn ngữ, kết thúc/đổi phiên theo lifecycle chung, không tự đổi giữa một lượt đang chạy.
- Thời gian 1.500/5.000/30.000 ms ở D05 đã chốt. Calibration 750 ms, margin 12/6 dB, min signal 120 ms, AGC ưu tiên tắt và bitrate 64 kbps vẫn là giá trị kỹ thuật khởi điểm để tune.
- D11 đo riêng thời gian chờ dưới ngưỡng, flush recorder, upload, STT, GPT, TTS, nhận response và bắt đầu phát. Mục tiêu tích hợp theo pipeline chung: p95 nghe câu trả lời đầu tiên ≤5 giây sau kết thúc thu, đo 30 câu ngắn mỗi ngôn ngữ/provider; không tuyên bố đã đạt.
- Frontend responsive thuộc người khác. Phần việc voice bàn giao input/output, cấu hình detector, trạng thái thu/phát/hủy, yêu cầu HTTPS/MIME và checklist iPad.
- Engine/memory chính thức vẫn do người khác làm. Adapter GPT tạm không truy xuất/lưu memory hoặc lịch sử hội thoại và không tự dựng các trường memory/character để giả lập tính năng đã có.

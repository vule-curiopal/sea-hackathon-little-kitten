# Lựa chọn cho hai bản voice input

Ngày: **31/10/2026**. Đi kèm [plan triển khai](speech-input-variants-plan.md). Các lựa chọn dưới đây chưa phải cấu hình đang chạy; không cần trả lời để đọc/review plan.

**Cập nhật đã chốt:** người dùng chọn ElevenLabs tự phát hiện/lọc nền và yêu cầu implement bản này trước; local model để sau. Realtime local hiện bật `commit_strategy=vad`, `filter_background_audio=true`, chờ 1 giây; các ngưỡng còn lại dùng mặc định provider. Bản ưu tiên mặc định bây giờ là **realtime**, thay đề xuất V04-A ban đầu. Không cần trả lời lại V04 để thực hiện lựa chọn này. Chi tiết runtime ở [elevenlabs-realtime.md](elevenlabs-realtime.md); các phương án dưới đây giữ để tra cứu.

Đã chốt từ yêu cầu: làm cả `local_vad_batch` và `elevenlabs_realtime`; **chỉ bàn giao full transcript sau khi chốt lượt cho engine/LLM**. Không cần quyết định lại điều này. Giữ voice, ngôn ngữ chọn trước phiên và TTS hiện tại.

## V01 — Chờ bao lâu sau khi không còn lời nói?

Khoảng nghỉ 2,2 giây đã bị RMS 1,5 giây cắt sớm. VAD đổi cách xác định “có lời”, nhưng vẫn phải chọn thời gian chờ.

| Chọn | Cấu hình thử | Đánh đổi |
| --- | --- | --- |
| **A — đề xuất** | 3 giây cho cả hai bản | Có thêm dư địa cho khoảng nghỉ 2,2 giây; phản hồi bắt đầu muộn hơn |
| B | 2,5 giây | Nhanh hơn nhưng biên an toàn nhỏ hơn |

ElevenLabs VAD realtime hiện hỗ trợ tối đa 3 giây. Giá trị dài hơn cần lớp gom lượt riêng hoặc Gửi thủ công. [Nguồn](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies)

**Nếu chưa có trả lời:** dùng A để thử, chưa coi là thông số production đã đo.

## V02 — Tự kết thúc hay xác nhận bằng nút Gửi?

“Chờ hết câu” được bảo đảm ở mức không đẩy chunk/partial tới LLM. VAD không biết chắc người dùng còn muốn nói gì sau một khoảng nghỉ dài.

| Chọn | Hành vi |
| --- | --- |
| **A — đề xuất** | Tự chốt theo V01; vẫn có Gửi ngay và Hủy |
| B | VAD giúp hiển thị trạng thái, nhưng chỉ chốt lượt khi bấm Gửi; phù hợp nếu muốn giữ cả những khoảng nghỉ rất dài |

**Nếu chưa có trả lời:** dùng A khi đã qua acceptance tự kết thúc. Nếu bản realtime chưa xác minh được flush/drain, chỉ dùng B trong thử nghiệm, không gửi partial thay cho transcript cuối.

## V03 — Một lượt dài hơn giới hạn 30 giây?

Contract hiện chỉ nhận audio tối đa 30 giây. Gửi ép ở mốc này có thể tạo câu dở, trái yêu cầu chờ hết lượt.

| Chọn | Hành vi |
| --- | --- |
| **A — đề xuất** | Giữ 30 giây; nếu vẫn đang nói thì dừng, báo chia lượt và không gọi engine |
| B | Nâng giới hạn, ví dụ 60 giây; phải cập nhật contract, queue/audio limits, timeout và test cả hai bản |

**Nếu chưa có trả lời:** dùng A. Không âm thầm giữ hành vi RMS cũ tự gửi tại `max_duration` cho hai chế độ mới.

## V04 — Chế độ nào mặc định sau khi cả hai đã qua test?

| Chọn | Đánh đổi |
| --- | --- |
| **A — đề xuất ban đầu** | Local VAD + batch: giữ gần pipeline hiện tại, không stream audio lên server trong lúc nói; cần tải model/runtime trên thiết bị |
| B | ElevenLabs realtime: không có model local, STT xử lý trong lúc nói; cần mạng/WS ổn định và xử lý drain transcript đúng |

**Nếu chưa có trả lời:** thử A trước, B bật trong selector demo. Chốt mặc định cuối cùng sau khi có số đo iPad và độ chính xác endpoint; không gọi bản B nhanh hơn khi chưa đo.

## Mẫu trả lời

```text
V01: A
V02: A
V03: A
V04: A
```

Các chi tiết kỹ thuật như version model/runtime, backend relay, auth và tên module sẽ được pin/kiểm chứng khi implement; không cần người dùng chọn thay cho các bước kỹ thuật đó. Logging dùng lựa chọn normal mode theo brain đã yêu cầu trước đây; không hỏi lại quyền đã có hoặc tự đổi privacy khi gặp lỗi.

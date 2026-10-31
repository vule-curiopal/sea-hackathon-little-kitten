# Log chẩn đoán voice trên server

Ứng dụng ghi mỗi event thành một dòng JSON vào stdout; systemd thu vào journal của **`miu-api.service`**. Không ghi thêm file trong release read-only và không bật webhook. Các event có timestamp UTC, `session_id`, `turn_id` và `connection_id` khi đã xác thực. Đổi ngày/giờ sang `Asia/Saigon` khi trao đổi với người test.

```bash
# Xem lỗi và các mốc của lượt vừa test
journalctl -u miu-api.service --since '10 minutes ago' --no-pager -o cat
# Theo dõi trực tiếp
journalctl -u miu-api.service -f -o cat
```

| Event | Ý nghĩa |
| --- | --- |
| `speech.connected`, `speech.closed` | WSS được mở/đóng; outcome và close code |
| `stt.connecting`, `stt.ready` | Đang chờ provider hoặc sẵn sàng; silence milliseconds |
| `stt.audio_started` | Backend đã nhận chunk audio đầu tiên |
| `stt.first_partial`, `stt.segment` | Có nhận dạng; chỉ số ký tự và số segment, không ghi nội dung |
| `stt.draining`, `stt.final` | Tổng chunk/byte/thời lượng audio và full transcript đã chốt |
| `turn.stage_started`, `turn.stage_completed` | Engine hoặc TTS bắt đầu/hoàn tất; thời gian kèm stage |
| `turn.failed` | Lỗi ở stage nào, mã lỗi ổn định và HTTP status nếu có |
| `stt.provider_failed` | Provider realtime lỗi; loại event đã biết, không ghi raw response |
| `speech.failed`, `speech.result` | Kết quả toàn lượt voice |
| `stt.canceled` | Lượt bị hủy, phase và số audio đã nhận |
| `client.error` | Browser báo mã lỗi mic/kết nối/playback |
| `http.failed` | Mã lỗi ở API HTTP |

`duration_ms` của các event lifecycle là thời gian kể từ lúc bắt đầu luồng/lượt tương ứng. Với `turn.stage_completed`, đây là thời gian của stage, có gồm các kiểm tra state/DB hiện có; không phải thời gian gọi model thuần. Partial chỉ ghi mốc đầu tiên và đếm tổng; không query DB hay log từng frame audio.

Browser gửi mã lỗi qua `POST /api/client-events`, dùng token của phiên hiện tại; tối đa 10 event/phút/phiên, và client gộp lỗi trùng trong 5 giây. Lỗi gửi diagnostic không làm hỏng hoặc tự retry lượt nói. Nếu mạng mất hoàn toàn hoặc phiên đã hết hạn, browser có thể không gửi được diagnostic; đối chiếu `speech.closed` và browser console. Log phía browser không phải bằng chứng đáng tin về lỗi provider.

Không ghi API key, bearer token, IP, raw URL, audio/base64, transcript, câu trả lời, request body hoặc raw error/stack. Chỉ metadata được allowlist mới ra journal; mã client ngoài danh sách chuyển thành `unknown_client_error`. Log tuân theo dung lượng/retention journal hiện có của server; không sửa chính sách log toàn máy hay dịch vụ khác.

Sau khi báo logger đã sẵn sàng, người dùng refresh web và test. Khi test xong, báo thời điểm tương đối và thiết bị; đọc journal tương ứng rồi lần theo cùng `turn_id` để xác định bước cuối hoàn tất và lỗi tiếp theo. Không cần gửi nội dung câu đã nói hoặc credentials.

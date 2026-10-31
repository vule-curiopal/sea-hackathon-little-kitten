# Kết quả kiểm thử 20 audio

**Phạm vi tài liệu này:** baseline RMS + STT batch. Bản ElevenLabs realtime mới đã được kiểm thử riêng: [guide và kết quả](../../docs/voice-pipeline/elevenlabs-realtime.md), [JSON realtime](realtime-validation.json). Không trộn các số liệu của hai mode.

Kiểm thử ngày 31/10/2026 bằng detector RMS hiện tại và provider thật. **Luồng cơ bản chạy được, nhưng detector chưa ổn trong mọi điều kiện**: nghỉ dài bị cắt câu, giọng quá nhỏ có thể bị bỏ sót, tiếng động có thể bị nhận nhầm thành lời.

## Phạm vi

- Chạy cả 20 WAV qua kiểm tra checksum, định dạng, validator backend và mô phỏng detector với bước 20 ms.
- Với mỗi quyết định `submit`, cắt WAV tại đúng thời điểm detector kết thúc rồi gửi qua HTTP thật tới một Express instance riêng trên localhost: ElevenLabs STT → GPT tạm → ElevenLabs TTS. Hai ca detector hủy không gọi provider.
- Dùng API và provider adapter của project, không dùng fake provider. Không gửi `fixture_id`.
- Không dùng engine nhân vật/memory, không đụng session production, không mô phỏng receipt đã phát audio. MP3 đầu ra được kiểm tra bằng audio inspector, chưa đánh giá bằng người nghe.
- Đây là mô phỏng PCM rồi upload HTTP; chưa phải kiểm thử MediaRecorder, browser DSP, microphone vật lý hoặc iPad. Các file có 1 giây tiếng nền đầu để calibration hoàn tất.

## Cấu hình logging và lỗi 403

Lần chạy đầu dùng nguyên cấu hình `.env`: `ELEVENLABS_ENABLE_LOGGING=false`. Cả 18 lượt được detector gửi đều thất bại ở provider. Một probe chẩn đoán xác nhận request STT có `enable_logging=false`, ElevenLabs trả HTTP 403 `not_allowed`.

Lần chạy chất lượng bên dưới dùng cờ **tường minh** `--normal-logging`: override logging trong tiến trình test thành `STT_LOGGING=1`, tương thích brain; request STT không có query `enable_logging`. **Không sửa `.env` và không tự fallback sau lỗi.** Cấu hình `.env` còn `false` vẫn có thể gây 403 khi chạy app bình thường.

Chứng cứ: [lần chạy bị chặn](real-validation-config-blocked.json), [lần chạy provider thật với normal logging](real-validation.json).

## Tổng hợp

| Kết quả | Số file |
| --- | ---: |
| WAV/checksum/backend audio validation hợp lệ | 20/20 |
| Detector tự submit | 18 |
| Detector hủy vì không xác nhận được tín hiệu | 2 |
| STT → GPT → TTS hoàn tất, MP3 hợp lệ | 17 |
| Tiếng động được gửi nhưng STT từ chối `unclear_audio` | 1 |
| Endpoint sớm, bỏ mất mệnh đề phía sau | 2 |
| STT có sai khác văn bản tham chiếu của đoạn đã gửi | 3 |

17 lượt hoàn tất có thời gian từ upload đến nhận và kiểm tra audio **2,96–5,41 giây**, trung vị **3,60 giây**. Không tính thời gian người dùng nói/đợi dừng thu, không phải benchmark p95 hoặc số đo trên iPad.

Hoàn tất pipeline không đồng nghĩa nhận dạng đúng hoặc giữ đủ câu: hai ca nghỉ dài vẫn trả MP3 thành công dù mệnh đề sau chưa được gửi.

## Kết quả từng nhóm file

| Ca Việt / Anh | Detector | Kết quả API thật |
| --- | --- | --- |
| `01_vi_clean` / `11_en_clean` | Tự gửi sau khoảng lặng | Cả hai hoàn tất; transcript khớp tham chiếu sau chuẩn hóa |
| `02_vi_soft` / `12_en_soft` | Việt gửi được; Anh hủy `no_signal` | Việt hoàn tất và nhận đúng; Anh không được upload |
| `03_vi_muffled` / `13_en_muffled` | Cả hai tự gửi | Việt đúng; Anh nhận tên “Miu” thành “Leo” |
| `04_vi_clipped` / `14_en_clipped` | Cả hai tự gửi | Cả hai hoàn tất, transcript khớp tham chiếu |
| `05_vi_fan_snr20` / `15_en_fan_snr20` | Cả hai tự gửi | Cả hai hoàn tất, transcript khớp tham chiếu |
| `06_vi_rain_snr10` / `16_en_rain_snr10` | Cả hai tự gửi | Cả hai hoàn tất, transcript khớp tham chiếu |
| `07_vi_noise_snr0` / `17_en_noise_snr0` | Cả hai chờ tới giới hạn 30 giây | Cả hai trả audio nhưng STT sai chữ; Việt có “chúng ta con” thay cho “chú mèo con”, Anh nhận “Miu” thành “Neil” |
| `08_vi_pause_0800ms` / `18_en_pause_0800ms` | Giữ được cả hai mệnh đề | Cả hai hoàn tất; transcript khớp cả câu |
| `09_vi_pause_2200ms` / `19_en_pause_2200ms` | Gửi trước mệnh đề thứ hai | API chỉ nhận và trả lời mệnh đề đầu; câu phía sau bị mất |
| `10_vi_noise_only` / `20_en_noise_only` | Việt hủy đúng; Anh nhận nhầm tiếng động và gửi | Việt không gọi API; Anh bị STT từ chối `unclear_audio`, không gọi GPT/TTS |

Chỉ số `normalized_token_error_rate` trong JSON là edit distance trên token cách nhau bằng khoảng trắng, bỏ dấu câu và khác biệt hoa/thường. Tham chiếu là lời đầu vào TTS, chưa phải alignment hoặc transcript được con người xác nhận. Với ca cắt sớm, chỉ số này so với phần câu đã gửi; xem thêm `premature_endpoint` để thấy mất câu phía sau.

## Chạy lại

```powershell
node --import tsx scripts/check-voice-test-audio.ts

# Dùng cấu hình logging hiện có; gọi provider thật, có tính phí.
node --env-file=.env --import tsx scripts/evaluate-voice-test-audio.ts --real

# Chủ động dùng normal logging trong tiến trình test, giữ nguyên file .env.
node --env-file=.env --import tsx scripts/evaluate-voice-test-audio.ts --real --normal-logging

# Chỉ thử một số file; báo cáo sẽ chỉ chứa các ca đã chọn.
node --env-file=.env --import tsx scripts/evaluate-voice-test-audio.ts --real --normal-logging --ids=01_vi_clean,11_en_clean
```

Script ghi đè `real-validation.json` sau mỗi lượt để giữ kết quả khi bị gián đoạn. Các lượt `real_request_failed` làm command trả exit code 1; noise-only bị từ chối vì không rõ lời được phân loại riêng. Script không lưu khóa API.

Các kiểm thử unit detector/capture/controller hiện có: **16/16 qua**. Một assertion cũ của controller được cập nhật để khớp tham số cấu hình character mới; không thay đổi logic runtime hoặc ngưỡng detector trong lần kiểm tra này.

## Điểm cần cải thiện

- Ngưỡng dừng 1,5 giây không giữ được khoảng nghỉ 2,2 giây. Có thể thử thời gian chờ dài hơn, đổi lại phản hồi sẽ chậm hơn; cần test lại trước khi chọn.
- RMS chỉ đo năng lượng nên không phân biệt chắc chắn lời nói và tiếng động. Giảm ngưỡng để bắt giọng nhỏ có thể tăng nhận nhầm nhiễu.
- Nhiễu mạnh giữ lượt mở tới 30 giây và làm giảm chất lượng nhận dạng. Cần kiểm thử thêm trên microphone thực tế trước khi chốt trải nghiệm.

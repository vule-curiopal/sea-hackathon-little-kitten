# Kế hoạch triển khai voice pipeline

Ngày cập nhật: **31/10/2026**. Đã triển khai backend **Express 5 + TypeScript trên Node.js**, tách routes/controllers, services, repository RAM và provider adapters; cùng thư viện browser RMS/capture/playback cho frontend React/TypeScript tích hợp trên iPad. Hướng dẫn chạy: [backend/pipeline/README.md](../../backend/pipeline/README.md). Bộ 139 test tự động dùng fake/mocked provider; các probe riêng đã chạy STT → GPT → TTS thật cho Việt/Anh trên máy phát triển và server. Chưa benchmark p95 hoặc kiểm thử iPad thật; xem [trạng thái triển khai](implementation-status.md).

Phạm vi đã thống nhất: **microphone → STT → GPT tạm → TTS → phát audio**, không memory. Engine trả lời chính thức do thành viên khác phụ trách. Xem [phân chia phạm vi](../voice-pipeline-scope.md) và [đặc tả sản phẩm](../product-specification.md).

## Đọc theo thứ tự

| Tài liệu | Nội dung |
| --- | --- |
| [decisions.md](decisions.md) | Ghi nhận D01–D12, voice đã kế thừa và checklist tài khoản/thiết bị |
| [voices.md](voices.md) | 5 voice ID đã chọn trong little-buddy-impl, mặc định Việt/Anh và ví dụ env |
| [implementation-plan.md](implementation-plan.md) | Kiến trúc, thứ tự thực hiện, module và điều kiện xong từng bước |
| [backend-architecture.md](backend-architecture.md) | Express routers/controllers, TurnService, SessionService/repository, adapters và shutdown |
| [Deployment](../../deploy/miu/README.md) | Frontend/API cùng miu.curiopal.com, service/cổng riêng, HTTPS và deploy thủ công có release/rollback |
| [implementation-status.md](implementation-status.md) | Phần đã triển khai, cách kiểm tra và các giới hạn bàn giao |
| [microphone-vad.md](microphone-vad.md) | Microphone, RMS/dBFS, ước lượng nền, ngưỡng thích nghi, thời gian im lặng và cách tune |
| [provider-parameters.md](provider-parameters.md) | Tham số ElevenLabs STT batch/TTS, giới hạn VAD/lọc nhiễu của batch, GPT tạm và cấu hình server |
| [integration-validation.md](integration-validation.md) | Hợp đồng frontend/backend/engine, Stop, xử lý lỗi và kịch bản kiểm thử |
| [Bộ 20 audio đầu vào](../../test-assets/voice-pipeline/README.md) | Việt/Anh, giọng tổng hợp mô phỏng trẻ em, lời rõ/nhỏ/méo/nhiễu, khoảng nghỉ và noise-only; có trang nghe thử |

## Phương án đã chọn

**Bạn đã chọn cách số 4 cho v1:** đo mức âm lượng với ngưỡng thích nghi. Web Audio và MediaRecorder dùng cùng stream; thu xong gửi nguyên blob qua endpoint turn chung tới backend Node/TS, rồi ElevenLabs STT batch. Frontend React/TS responsive trên iPad do thành viên frontend phụ trách; phần voice bàn giao contract, cấu hình và lifecycle.

Voice khởi điểm kế thừa từ repo tham chiếu: **Việt — Phan Anh `mgBpvrNosWzExdPuRbXP`**, **Anh — Little Dude II `fBD19tfE58bkETeiwUoC`**. Ba lựa chọn thay thế và nguồn xác nhận nằm trong [voices.md](voices.md).

Theo yêu cầu dùng cấu hình đang chạy của LittleBuddy brain, **`STT_LOGGING=1`** là mặc định: STT không gửi query `enable_logging`, TTS cũng không gửi query này. `STT_LOGGING=0` mới yêu cầu STT zero-retention bằng `enable_logging=false`; tài khoản hiện tại trả 403 cho chế độ đó nhưng STT bình thường trả 200. Đây là lựa chọn lưu dữ liệu phía ElevenLabs, không bật memory cho GPT hay log audio/transcript tại ứng dụng. Chi tiết ở [D10](decisions.md) và [tham số provider](provider-parameters.md).

```text
Chọn vi/en trước phiên → session/config theo API contract
Talk → getUserMedia với xử lý tiếng nói của trình duyệt
     → MediaRecorder ghi audio; AnalyserNode đo RMS trên cùng MediaStream
     → đo nền, đặt ngưỡng tương đối với nền, theo dõi khoảng dưới ngưỡng
     → bấm Gửi hoặc đủ khoảng im lặng sau khi đã có tín hiệu
     → dừng recorder, chờ chunk cuối, đóng mic và gom blob với MIME thật
     → POST /api/sessions/{session_id}/turns
     → backend → ElevenLabs Scribe v2 (batch STT, ngôn ngữ phiên)
     → backend → GPT tạm độc lập từng lượt
     → backend → ElevenLabs Flash v2.5 (TTS)
     → response envelope chung với audio base64/MIME thật
     → browser phát audio và gửi playback receipt; microphone vẫn tắt
```

Timing đã chốt: im lặng **1.500 ms**, chờ tín hiệu **5.000 ms** sau calibration, tối đa **30 giây/lượt** gồm cả calibration. Đo nền **750 ms**, margin **12/6 dB** và các ngưỡng còn lại là giá trị khởi điểm để tune. [API contracts](../api-contracts.md) đã đồng bộ 30 giây/5 MiB audio, 6 MiB toàn multipart và MP4/AAC cho iPad.

Các bảng API phân biệt vị trí path/query/header/body và ghi rõ trường không gửi. Các tham số RMS/ngưỡng/timer là config client, không gửi sang ElevenLabs. V1 gửi blob MediaRecorder bằng `file_format=other`, không yêu cầu tự encode PCM/resample hoặc tải model/WASM VAD.

Ưu tiên latency trong phạm vi batch: một request turn, payload gọn, kết nối provider tái sử dụng khi hỗ trợ và câu trả lời ngắn. Mục tiêu theo pipeline chung là p95 nghe audio đầu tiên **≤5 giây sau khi kết thúc thu câu ngắn**, đo 30 lượt mỗi ngôn ngữ/provider; đo riêng thời gian chờ khoảng dừng và flush recorder. Chưa có benchmark chứng minh đạt mục tiêu.

iPad cần HTTPS tin cậy, feature-detect MIME thay vì ép WebM, AudioContext khởi động từ thao tác Talk và xử lý trường hợp browser chặn phát audio. Checklist portrait/landscape/split view và touch nằm trong phần bàn giao frontend.

## Các giới hạn cần hiểu khi lựa chọn

- Browser hỗ trợ giảm một số tạp âm. Bộ phát hiện RMS chỉ quan sát mức âm, có thể nhầm tiếng quạt/TV/người bên cạnh và bỏ sót giọng nhỏ; chưa nhận diện nội dung hoặc người nói.
- Mốc thời gian phản hồi phải tách **chờ người dùng nói xong** khỏi **xử lý sau khi gửi**. Bản batch chưa chứng minh được mục tiêu latency sản phẩm.
- Không lưu audio/transcript ở ứng dụng không đồng nghĩa nhà cung cấp không lưu. Quyền dùng chế độ không lưu của ElevenLabs cần kiểm tra theo tài khoản; xem D10 trong [decisions.md](decisions.md).
- Với batch, ứng dụng tự quyết định lúc kết thúc thu bằng ngưỡng thích nghi hoặc nút Gửi rồi mới upload. Batch API không có tham số để tự dừng microphone đang thu.

Nguồn về API/browser được đặt gần phần liên quan; thuật toán ngưỡng thích nghi và các giá trị tuning là thiết kế đề xuất của dự án cho cách số 4 đã chọn.

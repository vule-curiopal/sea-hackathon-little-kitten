# Microphone và phát hiện dừng nói bằng ngưỡng âm lượng thích nghi

**Đã chốt cho v1:** cách số 4 — đo mức âm RMS, ước lượng mức nền và điều chỉnh ngưỡng theo nền; thu xong thì gửi audio trực tiếp qua backend tới ElevenLabs STT batch. Không dùng model Silero, WebRTC VAD, Audio Isolation hoặc realtime STT trong bản này. Giữ tên file hiện tại để các liên kết không bị đứt.

Cơ chế và timing D05 đã chốt: khoảng dưới ngưỡng **1.500 ms**, chờ tín hiệu ban đầu **5.000 ms**, thu tối đa **30.000 ms**. Calibration, margin và các ngưỡng còn lại là **khởi điểm đề xuất để tune**, chưa phải số đo hoặc default browser/provider. Mục tiêu thiết bị là iPad web; UI responsive và tích hợp mic/detector/player do người làm frontend phụ trách. Bộ phát hiện chỉ đo năng lượng; `hasSignal` không chứng minh đó là giọng người dùng.

## 1. Luồng audio v1

```text
Talk → xin quyền mic → một MediaStream
  ├─ MediaRecorder → các chunk trong RAM → blob hoàn chỉnh khi dừng
  └─ Web Audio AnalyserNode → RMS/dBFS → ước lượng nền → phát hiện khoảng dừng

Đủ khoảng dừng hoặc bấm Gửi
  → chốt đúng một lần → recorder.stop()
  → nhận dataavailable cuối và stop event
  → đóng tracks/AudioContext, gom blob với MIME thật
  → POST /api/sessions/{session_id}/turns theo API contract
  → backend forward file → ElevenLabs STT batch (file_format=other)
  → GPT tạm → TTS → phát audio
```

Cùng một stream phục vụ ghi âm và đo mức âm. Mức âm được phân tích sau xử lý microphone của browser. Nhánh đo không chỉnh sửa, gate, cắt hoặc normalize dữ liệu trong blob. Không nối nhánh mic ra loa.

Web Audio cung cấp sample dạng Float32 để tính mức âm: [AnalyserNode.getFloatTimeDomainData](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/getFloatTimeDomainData). Dừng MediaRecorder cần chờ phần dữ liệu cuối trước khi gom blob: [MediaRecorder stop event](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/stop_event).

## 2. Microphone constraints

Các trường dưới đây gửi cho `getUserMedia`, không phải tham số ElevenLabs. Kiểm tra capability trước khi yêu cầu và đọc `track.getSettings()` sau khi mở; browser có thể không áp dụng mọi tùy chọn. [W3C Media Capture](https://www.w3.org/TR/mediacapture-streams/)

| Constraint | Đề xuất v1 | Ghi chú |
| --- | --- | --- |
| `deviceId` | Không ép ban đầu; chọn mic cụ thể nếu UI có | Khi rút/đổi mic thì hủy lượt và đo nền lại |
| `echoCancellation` | `{ ideal: true }` | Giảm tiếng loa lọt vào mic |
| `noiseSuppression` | `{ ideal: true }` | Giảm một số tạp âm, không bảo đảm loại tiếng người bên cạnh |
| `autoGainControl` | `{ ideal: false }` | Đề xuất giữ mức ổn định cho đo ngưỡng; nếu bị ép bật thì ghi nhận và tune lại |
| `channelCount` | `{ ideal: 1 }` | Mong muốn mono; chấp nhận cấu hình thực tế được browser cấp |
| `sampleRate` | Không ép | Dùng sample rate thiết bị; không resample chỉ để tính RMS |
| `sampleSize`, `latency` | Không ép | Tránh yêu cầu phần cứng không cần thiết cho bản đầu |
| `video` | `false` | Chỉ microphone |

AGC có thể làm mức nền thay đổi ngay trong lượt; A/B bật/tắt trên mic thật trước khi chốt. Không tăng gain phần mềm, thêm noise gate, compressor, denoiser hoặc bộ lọc EQ trong baseline. Mức loa và hướng/khoảng cách mic vẫn cần thử trên thiết bị demo.

## 3. Cách đo mức âm và mức nền

1. Khi Talk mở mic thành công, bắt đầu recorder ngay để giữ audio từ đầu; đồng thời bắt đầu meter. UI báo đang đo nền trong khoảng `calibrationMs`, sau đó báo sẵn sàng nói. Stop luôn hoạt động.
2. Khoảng mỗi `analysisIntervalMs`, lấy waveform hiện tại từ AnalyserNode, tính `RMS = sqrt(mean(sample²))` và `levelDbfs = 20 * log10(max(RMS, 1e-6))`.
3. Trong khoảng đo nền, lấy phân vị 20% của các mức đo làm `noiseFloorDbfs` ban đầu rồi chặn trong khoảng cấu hình. Đây là heuristic của ứng dụng, không phải đo độ ồn dB SPL của căn phòng.
4. Trước khi xác nhận tín hiệu nói, chỉ cập nhật nền từ các mẫu dưới ngưỡng kết thúc và ngoài đoạn ứng viên tín hiệu. Dùng cửa sổ mẫu nền cùng làm mượt theo thời gian để thích nghi với nền thay đổi chậm.
5. Khi xác nhận tín hiệu, giữ cố định mức nền và ngưỡng cho phần còn lại của lượt. Không đưa âm đang nói vào tập mẫu nền vì dễ khiến ngưỡng tăng và mất lời nói nhỏ.

Nếu người dùng nói trong lúc đo nền, audio vẫn có trong blob nhưng nền ước lượng có thể sai, nhất là khi nói suốt khoảng đo. UI cho bấm Gửi thủ công hoặc thu lại; không cam kết tách được nền/giọng nói chỉ bằng RMS. Mỗi lần Talk mới phải đo lại nền, không nghe mic trước thao tác đó.

## 4. Ngưỡng thích nghi và phát hiện kết thúc

```text
startThresholdDbfs = clamp(noiseFloorDbfs + startMarginDb, startMinDbfs, startMaxDbfs)
endThresholdDbfs   = clamp(noiseFloorDbfs + endMarginDb, endMinDbfs, endMaxDbfs)
```

Luôn giữ `endThresholdDbfs < startThresholdDbfs`. Khoảng cách hai ngưỡng giúp trạng thái không bật/tắt liên tục ở vùng biên.

- **Chờ bắt đầu:** mức đo đạt/vượt ngưỡng bắt đầu liên tục đủ `minSignalMs` thì đặt `hasSignal=true`. Nếu ứng viên rơi xuống dưới ngưỡng bắt đầu trước khi đủ thời gian thì reset ứng viên.
- **Đã có tín hiệu:** mức dưới ngưỡng kết thúc bắt đầu khoảng chờ im lặng. Bất kỳ mẫu hợp lệ nào đạt/vượt ngưỡng kết thúc đều reset khoảng chờ này.
- **Tự gửi:** chỉ sau khi `hasSignal=true` và có đủ `endSilenceMs` dưới ngưỡng kết thúc; gọi chung một hàm finalize với nút Gửi.
- **Nền lớn liên tục:** có thể bị nhận là tín hiệu nói và giữ lượt đến giới hạn cứng; đó là giới hạn đã biết của phương pháp mức âm.

Ví dụ đề xuất: nền `-60 dBFS` → ngưỡng bắt đầu `-48 dBFS`, kết thúc `-54 dBFS`. Nói vượt `-48 dBFS` đủ 120 ms → bắt đầu theo dõi khoảng dừng. Sau đó mức dưới `-54 dBFS` khoảng 1.500 ms → gửi. Các số này là ví dụ tuning, không biểu thị độ chính xác nhận diện giọng nói.

## 5. Tham số nội bộ đề xuất

Tất cả là **client config**, không gửi sang ElevenLabs.

| Tên | Khởi điểm | Ý nghĩa / đánh đổi |
| --- | --- | --- |
| `endpointDetector` | `adaptive_rms` | Cơ chế v1 đã chốt |
| `analysisIntervalMs` | `20` ms | Nhịp đọc meter; không giả định timer luôn chạy đúng nhịp |
| `maxAnalysisGapMs` | `250` ms | Gap đo quá lớn thì hủy lượt, không cộng phần thiếu dữ liệu thành im lặng |
| `analyserFftSize` | `1024` | Số sample trong waveform; cửa sổ thời gian phụ thuộc sample rate thật |
| `calibrationMs` | `750` ms | Khoảng đo nền khi mic đã mở; UI hướng dẫn chờ trước khi nói |
| `noisePercentile` | `20` | Phân vị thấp giảm ảnh hưởng tiếng động ngắn; không loại được mọi tiếng nói |
| `noiseFloorMinDbfs` / `noiseFloorMaxDbfs` | `-80` / `-25` | Giới hạn giá trị nền để tránh ngưỡng bất thường |
| `noiseWindowMs` | `2000` ms | Lịch sử mức nền hợp lệ trước khi xác nhận tín hiệu |
| `noiseAdaptationMs` | `1000` ms | Hằng số làm mượt nền; dùng elapsed time thực để tính hệ số cập nhật |
| `startMarginDb` / `endMarginDb` | `12` / `6` dB | Độ chênh với nền, không phải xác suất speech |
| `startMinDbfs` / `startMaxDbfs` | `-55` / `-15` | Chặn ngưỡng bắt đầu |
| `endMinDbfs` / `endMaxDbfs` | `-61` / `-21` | Chặn ngưỡng kết thúc, giữ thấp hơn ngưỡng bắt đầu |
| `minSignalMs` | `120` ms | Giảm nhận nhầm click; tăng quá cao dễ mất câu ngắn |
| `endSilenceMs` | `1500` ms | Khoảng dưới ngưỡng kết thúc trước tự gửi |
| `initialSilenceTimeoutMs` | `5000` ms | Đếm sau khi đo nền xong; chưa có tín hiệu thì đóng mic, không tự gửi |
| `maxRecordingMs` | `30000` ms | Giới hạn cứng kể từ recorder bắt đầu, gồm cả đo nền |
| `manualSendEnabled` | `true` | Gửi chủ động có thể vượt qua quyết định âm lượng |
| `minimumUploadMs` | `100` ms | Ngưỡng tối thiểu audio kỹ thuật, không dùng để kết luận có lời nói |
| `audioBitsPerSecond` | `64000` | Gợi ý MediaRecorder; bitrate thực có thể khác |
| `maxAudioBytes` | `5242880` | Audio tối đa 5 MiB, theo API contract |
| `maxRequestBytes` | `6291456` | Giới hạn toàn bộ request 6 MiB, gồm metadata/boundary |

Timing 1.500/5.000/30.000 ms là lựa chọn D05-A đã được bạn xác nhận. Giới hạn [API contracts](../api-contracts.md) đồng bộ thành 30 giây/5 MiB audio và 6 MiB toàn multipart; client/backend/proxy cùng áp dụng. Không có giới hạn riêng cho harness khác với app.

Dùng `performance.now()` để tính thời gian trên client; không đếm số callback rồi nhân 20 ms. Khoảng cách giữa lần đo lớn bất thường, tab ẩn hoặc audio bị suspend thì hủy lượt, không xem phần thiếu dữ liệu là im lặng. Reset timer và trạng thái cho mỗi lượt mới.

## 6. Giữ nguyên blob rồi gửi batch

- Trên iPad, feature-detect các ứng viên được provider chấp nhận: `audio/mp4;codecs=mp4a.40.2`, `audio/mp4`, `audio/webm;codecs=opus`, `audio/webm`; lấy ứng viên được `MediaRecorder.isTypeSupported()` xác nhận và vẫn xử lý lỗi khởi tạo/ghi thực tế. MP4/AAC là đường cần kiểm thử trực tiếp trên iPad.
- Không mặc định mọi Safari đều chỉ có MP4: Safari 18.4 đã thêm WebM/Opus; vẫn dùng capability và `recorder.mimeType` thực, ghi phiên bản iPadOS/browser khi thử. Nếu không có format end to end phù hợp thì báo lỗi rõ, không đổi nhãn sang WAV/PCM.
- Gom các chunk theo thứ tự sau `dataavailable` cuối và `stop`; dùng `recorder.mimeType` thực, MIME blob và phần mở rộng file khớp container. Không upload riêng từng chunk trong lúc thu.
- Backend gửi nguyên bytes bằng form field `file`, `model_id=scribe_v2`, `file_format=other`. Không chuyển qua Audio Isolation, không tự normalize/trim/transcode/resample trong v1.
- Blob giữ cả đoạn đo nền và đuôi im lặng; chưa làm pre-roll/cắt đoạn riêng. V1 vẫn cần đo kích thước và thời gian để không giữ RAM vô hạn.

Nguồn: [MediaRecorder MIME](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/mimeType), [isTypeSupported](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static), [ElevenLabs batch STT](https://elevenlabs.io/docs/api-reference/speech-to-text/convert).

ElevenLabs công bố hỗ trợ MP4/M4A/AAC và WebM: [STT supported formats](https://elevenlabs.io/docs/overview/capabilities/speech-to-text). Nguồn về browser: [WebKit MediaRecorder](https://webkit.org/blog/11353/mediarecorder-api/), [Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/).

## 7. Gửi, hủy và các trường hợp biên

- **Tự dừng:** chỉ gửi khi detector đã xác nhận tín hiệu; đây có thể là tiếng ồn, nên backend vẫn phải kiểm tra transcript rỗng/lỗi.
- **Bấm Gửi:** dừng và flush blob hiện tại; cho gửi dù `hasSignal=false` khi đủ duration/byte để người dùng vượt qua detector nếu nói quá nhỏ. Không cam kết chặn mọi audio im lặng khi người dùng chủ động gửi.
- **Hết giới hạn cứng:** có tín hiệu thì chốt một lần; chưa có thì bỏ lượt. Không tạo vòng thu mới tự động.
- **Stop/Hủy/tab ẩn/đổi mic:** invalidate lượt trước; stop recorder và tracks, đóng AudioContext, xóa chunk/timer. Event `dataavailable`/`stop` đến muộn phải bị bỏ, không upload.
- **Meter lỗi:** tắt auto-send và báo dùng Gửi thủ công; recorder lỗi thì hủy cả lượt. Không có bước tải model VAD trong v1.

Tất cả nguồn kết thúc dùng `finalizeCapture(reason)` có guard chốt một lần. Tách `reason=submit` khỏi `reason=cancel`; hủy không được vô tình đi vào callback upload.

## 8. Chẩn đoán và tune

Màn debug hiển thị: RMS/dBFS, nền hiện tại, hai ngưỡng, `hasSignal`, thời gian dưới ngưỡng, calibration state, MIME/bitrate thực, mic settings và thời gian từng API. Đây là công cụ kiểm thử cho người lớn; không lưu waveform, audio, nội dung hội thoại, tên mic hoặc device ID vào telemetry.

Thử lần lượt: phòng yên tĩnh → quạt/điều hòa → nói nhỏ → câu “ừ/yes/no” → ngập ngừng → tiếng người bên cạnh → nền đổi đột ngột. Chỉnh margin/minSignal trước khi tăng mọi mức lọc. Nền thay đổi mạnh trong câu có thể phải thu lại; không cho bộ ước lượng nền tự học luôn tiếng nói để che lỗi.

Phương pháp này phù hợp bản đầu đơn giản, vẫn có thể nhầm tiếng động hoặc tiếng người khác thành lời nói và cắt câu nhỏ/chậm. VAD bằng model chỉ xem xét ở bước sau khi có dữ liệu thử, không là phụ thuộc hoặc hạng mục triển khai v1.

## 9. Điều kiện iPad và bàn giao cho frontend

| Điều kiện | Yêu cầu tích hợp |
| --- | --- |
| Secure context | Mở app trên origin HTTPS được iPad tin cậy; kiểm tra `window.isSecureContext`. IP LAN HTTP của laptop không phải localhost trên iPad; dùng HTTPS cùng origin/reverse proxy/tunnel phù hợp |
| User gesture | Tạo/resume AudioContext trong handler Talk; chờ trạng thái chạy trước khi dùng meter cho auto-end. Không cho lúc xin quyền/suspend trở thành khoảng im lặng giả |
| Capture interruption | Sau khi bắt đầu thu, nếu tab ẩn, màn hình khóa, context suspended/interrupted hoặc gap đo quá lớn thì hủy lượt, cleanup và chờ Talk mới |
| Playback | Giải mã audio base64 theo `audio.mime_type` của response; xử lý promise `play()`/`NotAllowedError`, có nút Phát chủ động cho lượt còn hiệu lực; gửi receipt theo việc phát thật |
| Responsive | Frontend owner giữ Talk/Gửi/Stop/Phát tiếp cận được ở portrait, landscape và split view, touch target tối thiểu 48 CSS px; đổi layout không remount/reset capture ngoài ý muốn |
| Ngôn ngữ | Chọn `vi` hoặc `en` trước phiên, gửi config server; không auto-switch theo detector hoặc STT output |

Nguồn: [getUserMedia và HTTPS](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts), [Web Audio best practices](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices), [AudioContext state](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state), [play() rejection](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play).

Phần của bạn cung cấp contract/cấu hình, yêu cầu lifecycle và kiểm thử audio backend; người làm frontend triển khai UI responsive và phần browser theo spec này. Đường HTTPS/mic/playback phải chạy trên iPad thật, desktop responsive preview chưa đủ xác nhận tương thích thiết bị.

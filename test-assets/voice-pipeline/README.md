# 20 audio đầu vào để thử voice pipeline

**10 file Việt + 10 file Anh**, gồm 18 file có lời và 2 negative control chỉ có tiếng nền. WAV PCM16, mono, 24 kHz; mỗi file khoảng 5,9–30 giây, tối đa khoảng 1,44 MB, nằm trong giới hạn backend. Tổng WAV khoảng 8,32 MB.

Mở [preview.html](preview.html) bằng trình duyệt để nghe từng file và đọc câu gốc. Các file nằm trong [audio/](audio/); [manifest.json](manifest.json) và [manifest.csv](manifest.csv) có thông tin từng file. [validation.json](validation.json) là báo cáo kiểm tra định dạng và mô phỏng detector đã chạy.

## Giọng nói và nguồn tạo

Giọng **tổng hợp mô phỏng trẻ em**, tạo bằng ElevenLabs TTS rồi chỉnh cao độ/formant nhẹ: Cam Hong cho Việt (+3 semitone), Little Dude II cho Anh (+2 semitone). Đây là dữ liệu giả lập để thử chức năng; chưa có đánh giá người nghe về độ tự nhiên/tuổi giọng và không thay thế bộ thu giọng trẻ em thật.

Sáu đoạn lời hư cấu được tổng hợp bằng `eleven_flash_v2_5` qua API thật, tổng 196 ký tự đầu vào. Những câu rõ và biến thể nhiễu dùng chung nguồn để so sánh ảnh hưởng của điều kiện âm thanh. Không tạo clone mới. Tiếng nền được tổng hợp bằng DSP với seed cố định, không lấy từ bản ghi người thật. Job tạo nguồn dùng `enable_logging=true`; không phải kiểm thử real STT/GPT/TTS và không thay đổi `.env`/provider mode của ứng dụng. Không có API key trong dữ liệu hoặc manifest.

| Ngôn ngữ | Câu baseline, dùng ở ca 01–07 / 11–17 |
| --- | --- |
| Việt | Miu ơi, mình muốn nghe một câu chuyện về chú mèo con. |
| Anh | Miu, can you tell me a story about a little kitten? |

Hai ca khoảng nghỉ dùng các mệnh đề được tổng hợp riêng:

- Việt: “Hôm nay mình hơi buồn.” → khoảng nghỉ → “Bạn chơi với mình nhé.”
- Anh: “I feel a little sad today.” → khoảng nghỉ → “Will you play with me?”

`reference_text` là lời đầu vào TTS để đối chiếu, chưa phải transcript được con người hoặc STT xác nhận. `segments` là ranh giới đoạn nguồn, không phải alignment từng từ.

## Danh sách file

| Case | File Việt | File Anh | Mục đích |
| --- | --- | --- | --- |
| Rõ | [01_vi_clean.wav](audio/01_vi_clean.wav) | [11_en_clean.wav](audio/11_en_clean.wav) | Baseline, giọng khoảng −24 dBFS RMS |
| Nói nhỏ | [02_vi_soft.wav](audio/02_vi_soft.wav) | [12_en_soft.wav](audio/12_en_soft.wav) | Giọng −58 dBFS RMS, thử bỏ sót tín hiệu/Gửi thủ công |
| Nghẹt | [03_vi_muffled.wav](audio/03_vi_muffled.wav) | [13_en_muffled.wav](audio/13_en_muffled.wav) | Low-pass 1.000 Hz, giả lập mic bị che |
| Vỡ tiếng | [04_vi_clipped.wav](audio/04_vi_clipped.wav) | [14_en_clipped.wav](audio/14_en_clipped.wav) | Hard clipping trước khi xuất PCM hợp lệ |
| Nền quạt | [05_vi_fan_snr20.wav](audio/05_vi_fan_snr20.wav) | [15_en_fan_snr20.wav](audio/15_en_fan_snr20.wav) | Nhiễu ổn định, SNR +20 dB |
| Nền mưa | [06_vi_rain_snr10.wav](audio/06_vi_rain_snr10.wav) | [16_en_rain_snr10.wav](audio/16_en_rain_snr10.wav) | Nhiễu vừa, SNR +10 dB |
| Nhiễu mạnh | [07_vi_noise_snr0.wav](audio/07_vi_noise_snr0.wav) | [17_en_noise_snr0.wav](audio/17_en_noise_snr0.wav) | SNR 0 dB; nền tăng sau calibration, kéo dài đủ 30 giây để thử giới hạn thu |
| Nghỉ ngắn | [08_vi_pause_0800ms.wav](audio/08_vi_pause_0800ms.wav) | [18_en_pause_0800ms.wav](audio/18_en_pause_0800ms.wav) | Nghỉ 800 ms giữa hai mệnh đề |
| Nghỉ dài | [09_vi_pause_2200ms.wav](audio/09_vi_pause_2200ms.wav) | [19_en_pause_2200ms.wav](audio/19_en_pause_2200ms.wav) | Nghỉ 2.200 ms, có thể bị auto-end trước câu sau |
| Không lời | [10_vi_noise_only.wav](audio/10_vi_noise_only.wav) | [20_en_noise_only.wav](audio/20_en_noise_only.wav) | Việt: quạt đều; Anh: thêm tiếng động mạnh 1,2–1,9 giây để thử false trigger |

File có lời đều có 1.000 ms tiếng nền trước lời để calibration 750 ms hoàn tất, và ít nhất 2.000 ms nền sau lời. Hai file nhiễu mạnh có phần nền cuối dài đến mốc 30 giây. Nhiễu quạt/mưa hiện diện cả đầu và đuôi; phần nền này không phải digital silence.

SNR được tính trên tổng vùng đoạn lời đã khai báo, bao gồm khoảng nghỉ tự nhiên bên trong mỗi đoạn nguồn. Manifest lưu cả target và mức đo trên thành phần speech/noise trước lượng tử PCM. SNR lớn hơn nghĩa là lời nổi hơn nền. Clipping/low-pass là giả lập méo tín hiệu; bộ này chưa mô phỏng phát âm sai hoặc nói líu tự nhiên của trẻ.

## Cách dùng

**Thử backend/STT:** chọn phiên `vi` hoặc `en` đúng ngôn ngữ file. Gửi WAV nguyên bản vào trường multipart `audio` tại `POST /api/sessions/{session_id}/turns`, kèm `request_id`, `kind=utterance`, `language_hint`. Xem [backend README](../../backend/pipeline/README.md) để tạo session/token/config trước. Cần real provider để đánh giá nhận dạng/câu trả lời thực; fake mode dùng sample Buddy cố định và không nhận dạng các WAV này. Khi thử real không gửi `fixture_id`. Hai ca không lời có `reference_text=""`; ghi nhận cả transcript bịa nếu provider trả lời trên noise-only.

**Thử thuật toán dừng nói bằng waveform:** chạy từ root, không cần API key hoặc microphone:

```powershell
npx tsx scripts/check-voice-test-audio.ts
```

Script kiểm tra SHA256, metadata WAV, dung lượng/duration, gọi validator audio thật của backend và đưa mẫu PCM vào detector hiện tại với cửa sổ 20 ms. Kết quả lưu ở `validation.json`. Không gọi provider và không kiểm thử MediaRecorder, browser DSP hoặc mic vật lý.

**Thử microphone trên iPad:** phát file từ một thiết bị khác rồi dùng Talk trên thiết bị đang thử. Khởi động capture trước khi phát để có phần nền calibration. Mức loa, khoảng cách, phòng và xử lý browser làm mức âm/SNR ở microphone khác file gốc; ghi nhận các điều kiện đó khi so sánh. Đây là lượt kiểm thử riêng, chưa được thực hiện trong bộ dữ liệu này.

## Kết quả offline đã ghi nhận

Cả 20 file qua kiểm tra WAV, checksum và backend audio validation. Với cấu hình RMS mặc định, mô phỏng cho 18 quyết định submit và 2 no-signal; không còn file kết thúc trước khi detector ra quyết định.

- Hai ca nghỉ 800 ms giữ được hai mệnh đề; hai ca nghỉ 2.200 ms submit trước mệnh đề sau.
- Hai ca nhiễu mạnh giữ detector mở và submit tại giới hạn 30.000 ms.
- `12_en_soft` không xác nhận được tín hiệu và kết thúc bằng no-signal; `02_vi_soft` vẫn xác nhận được tín hiệu. RMS trung bình cả câu giống nhau không có nghĩa chuỗi mức âm theo thời gian giống nhau.
- `10_vi_noise_only` kết thúc bằng no-signal; `20_en_noise_only` nhận nhầm tiếng động thành tín hiệu rồi submit, dù không có lời nói.

Đây là quan sát của mô phỏng PCM, chưa là kết quả STT, iPad hoặc đo latency end-to-end. Không sửa ngưỡng detector chỉ để các fixture đều được gửi thành công.

## Tạo lại bộ file

Máy cần Python 3.10+, FFmpeg có filter `rubberband`, và các thư viện bên dưới:

```powershell
python -m pip install -r scripts/voice-test-audio-requirements.txt
python scripts/generate-voice-test-audio.py
npx tsx scripts/check-voice-test-audio.ts
```

Lệnh mặc định chỉ dùng sáu nguồn TTS trong cache local `.cache/voice-test-audio/tts/`; cache bị gitignore. Máy clone mới chưa có cache có thể chủ động cho phép gọi TTS tính credit bằng:

```powershell
python scripts/generate-voice-test-audio.py --fetch-tts
```

Khóa được đọc từ environment/root `.env`, không in ra. Chỉ fetch những nguồn còn thiếu, tối đa sáu request. Noise/rendering có thể tái lập từ cache cùng seed và phiên bản công cụ; seed của TTS chỉ là best effort. Manifest lưu hash nguồn, cấu hình và phiên bản FFmpeg/NumPy/SciPy. Các WAV đã tạo sẵn dùng trực tiếp được, không cần generate lại.

Tham khảo endpoint tạo nguồn: [ElevenLabs Create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert).

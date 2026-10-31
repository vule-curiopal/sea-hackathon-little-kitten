# Voice ElevenLabs kế thừa từ little-buddy-impl

Đọc trực tiếp ngày **31/10/2026** từ bản local **`D:/Intern/LittleBuddy_Implementation`**, repo `phatnguyen-curiopal/little-buddy-impl`, HEAD `6c3d848a0e69b603750980ae6dd7b002235a07c8`. Đây là các voice đã được chọn trong bản local mà bạn chỉ định.

Đã kiểm tra các file `.env`, `brain/.env`, `backend/.env` của bản local: không có biến chứa voice ID. Nguồn xác nhận **voice ID, nhãn, ngôn ngữ và mặc định** là `backend/store/migrations/008_voice_language.sql`, dòng 14–18. `backend/tests/helpers/db.js` khai báo cùng danh sách và `DEFAULT_VOICES` tương ứng. Chưa truy vấn database hoặc dịch vụ đang chạy; ID trong tài liệu được lấy từ các file local này. Không sao chép API key hay giá trị secret từ env.

## Danh sách voice được đưa vào allowlist

| Ngôn ngữ | Nhãn trong repo tham chiếu | Voice ID | Mặc định theo ngôn ngữ trong migration |
| --- | --- | --- | --- |
| Việt (`vi`) | Phan Anh | `mgBpvrNosWzExdPuRbXP` | Có |
| Việt (`vi`) | Cam Hong | `x4KAhuXs2G8TfK9Zr7Q4` | Không |
| Anh (`en`) | Little Dude II | `fBD19tfE58bkETeiwUoC` | Có |
| Anh (`en`) | Ziggy | `87n4zM8Wuy87vFILuKvE` | Không |
| Anh (`en`) | The Elf | `e79twtVS2278lVZZQiAD` | Không |

Nhãn ở đây giữ đúng tên trong repo tham chiếu, chưa xác minh tên hiển thị hiện tại trong thư viện ElevenLabs. Các file nghe thử được repo tham chiếu lưu tại `frontend/public/voice-samples/<voice-id>.wav`; hai sample mặc định đã được sao chép làm fixture của pipeline, xem [nguồn fixture](../../backend/pipeline/fixtures/README.md).

## Cấu hình khởi điểm cho v1

Kế thừa hai mặc định theo ngôn ngữ của migration:

```dotenv
ELEVENLABS_VOICE_ID_VI=mgBpvrNosWzExdPuRbXP
ELEVENLABS_VOICE_ID_EN=fBD19tfE58bkETeiwUoC
```

Đây là ví dụ cấu hình **chỉ chứa voice ID**, không có API key. Provider/model TTS của v1 vẫn theo [provider-parameters.md](provider-parameters.md), hiện là `eleven_flash_v2_5`/MP3; đồng bộ logging theo brain không đổi model hoặc format này.

| Tiếng chọn trước phiên | Voice mặc định v1 | Voice thay thế trong allowlist |
| --- | --- | --- |
| `vi` | Phan Anh — `mgBpvrNosWzExdPuRbXP` | Cam Hong — `x4KAhuXs2G8TfK9Zr7Q4` |
| `en` | Little Dude II — `fBD19tfE58bkETeiwUoC` | Ziggy — `87n4zM8Wuy87vFILuKvE`; The Elf — `e79twtVS2278lVZZQiAD` |

Frontend chọn `language_mode=vi|en` trước phiên. Backend dùng mặc định tương ứng khi chưa có lựa chọn voice hợp lệ; nếu có lựa chọn thì xác minh ID thuộc allowlist của ngôn ngữ đó. Cấu hình hiệu lực vẫn đi qua trường **`voice_id`** hiện có trong [API contract](../api-contracts.md). Hai tên env là cấu hình server, không thêm `voice_id_vi`/`voice_id_en` vào API public. Khi đổi ngôn ngữ trước một phiên mới, giải quyết lại voice hợp lệ cho tiếng mới; không giữ nhầm ID của tiếng cũ.

## Kiểm tra chéo tại bản local

Các file sau cùng xác nhận bộ voice đang dùng trong source local:

| File tương đối từ root local | Bằng chứng |
| --- | --- |
| `backend/store/migrations/008_voice_language.sql` | 5 ID, nhãn, ngôn ngữ và hai default |
| `backend/tests/helpers/db.js` | Cùng danh sách; `DEFAULT_VOICES.vi` và `.en` đúng hai ID mặc định |
| `brain/scripts/voice_samples.js` | Ví dụ tạo mẫu dùng Phan Anh cho `vi`, Little Dude II cho `en` |
| `frontend/public/voice-samples/` | Có file WAV mẫu tên theo 5 ID |

V1 Miu kế thừa mặc định theo ngôn ngữ đã nêu. Không cần truy cập API ElevenLabs để trích xuất các ID này.

## Kiểm tra provider và nghe thử

- D08 đã có bộ ID/allowlist và cấu hình khởi điểm, không còn cần hỏi lại mã voice.
- Probe thật STT → GPT → TTS đã qua cho hai voice mặc định Việt/Anh với Flash v2.5/MP3; chưa xác minh toàn bộ 5 voice hoặc nghe thử trên iPad. Các lượt probe không phải benchmark p95; xem [trạng thái triển khai](implementation-status.md).
- D10 dùng normal mode theo brain theo yêu cầu của bạn: STT mặc định `STT_LOGGING=1`, TTS không gửi logging query. Tier/thời hạn retention cụ thể chưa rõ; STT ZRM hiện trả 403 và không phải chế độ đang dùng. Việc tìm thấy ID không tự xác minh chính sách dữ liệu hoặc quyền của mọi voice.

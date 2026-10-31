# Phạm vi phụ trách: Voice pipeline STT → GPT tạm → TTS

## 1. Mục tiêu và ranh giới

Bạn phụ trách luồng nhận giọng nói của người dùng, chuyển thành văn bản bằng STT (Speech-to-Text), gọi bộ sinh câu trả lời, rồi chuyển câu trả lời thành giọng nói bằng TTS (Text-to-Speech).

Trong giai đoạn hiện tại, dùng một model GPT đơn giản làm bộ sinh câu trả lời tạm để kiểm thử toàn bộ luồng. Engine trả lời chính thức do thành viên khác phát triển và sẽ thay thế phần GPT tạm qua một interface thống nhất.

**Chưa triển khai memory cho bot.** Mỗi lượt gọi GPT tạm chỉ cần nội dung người dùng vừa nói và hướng dẫn trả lời cố định; không truy xuất hay lưu lịch sử hội thoại, thông tin cá nhân hoặc trạng thái quan hệ. Dữ liệu tạm phục vụ lượt đang xử lý được giải phóng sau khi hoàn tất hoặc hủy.

**Đã chốt bản đầu:** STT ElevenLabs batch; ứng dụng phát hiện khoảng dừng bằng mức âm lượng với ngưỡng thích nghi (cách số 4). MediaRecorder ghi audio, Web Audio đo RMS/nền; dừng rồi gom blob hoàn chỉnh và gửi nguyên bytes qua backend tới ElevenLabs (`file_format=other`). V1 chưa dùng model VAD, Audio Isolation hoặc chuyển PCM thủ công. Kế hoạch và tham số ở [bộ docs voice pipeline](voice-pipeline/README.md).

Theo câu trả lời D01–D12: ElevenLabs dùng cho cả TTS; backend Node.js/TypeScript; frontend React/TypeScript responsive trên iPad do người khác phụ trách. Timing chốt 1.500 ms im lặng, 5.000 ms chờ ban đầu, tối đa 30 giây ghi. Chọn `vi` hoặc `en` trước phiên; GPT tạm `gpt-6-luna`, effort none, tối đa 200 output token. D08 đã lấy [5 voice từ bản local little-buddy-impl](voice-pipeline/voices.md), mặc định Việt Phan Anh và Anh Little Dude II. D10 chưa rõ gói/retention, cần xác minh trước API thật. Tích hợp qua [API contract chung](api-contracts.md), một endpoint turn, ưu tiên latency trong phạm vi batch.

Tài liệu này phân chia công việc cho giai đoạn tích hợp voice, không thay thế toàn bộ yêu cầu sản phẩm trong [product-specification.md](product-specification.md). Những tính năng P0 của sản phẩm nằm ngoài phạm vi dưới đây vẫn cần người phụ trách riêng.

## 2. Luồng cần thực hiện

```text
Người dùng bấm Talk
  → Thu âm qua microphone
  → Đo RMS/nền, tự kết thúc khi dưới ngưỡng đủ lâu / bấm Gửi / đạt giới hạn
  → Chờ chunk cuối của MediaRecorder, gom blob đúng MIME, đóng microphone
  → STT: audio → transcript
  → Response generator: transcript → replyText
      Hiện tại: GPT đơn giản, không memory
      Sau này: engine do thành viên khác cung cấp
  → TTS: replyText → audio
  → Phát audio và báo trạng thái cho giao diện
```

Nút Stop phải hoạt động ở mọi bước: dừng thu âm, dừng phát âm thanh, hủy tác vụ nếu nhà cung cấp hỗ trợ và loại bỏ kết quả đến muộn.

## 3. Công việc thuộc phạm vi của bạn

| Hạng mục | Việc cần làm | Kết quả bàn giao |
| --- | --- | --- |
| Thu âm | Bàn giao spec/cấu hình MediaRecorder + RMS/ngưỡng, MIME và timer; phối hợp frontend triển khai trên iPad | Blob MP4/AAC hoặc WebM hợp lệ; lifecycle thu/hủy rõ ràng |
| STT | Tích hợp ElevenLabs batch; xử lý container thực, ngôn ngữ phiên, timeout, lỗi và transcript rỗng | Transcript bằng tiếng Việt/Anh đã chọn |
| GPT tạm | Gọi một model GPT với transcript hiện tại; dùng hướng dẫn cố định để trả lời ngắn bằng tiếng Việt hoặc tiếng Anh; không thêm memory, tool hay hành động thay đổi trạng thái | Văn bản trả lời đơn giản để chạy thử luồng |
| Điểm nối engine | Tách lời gọi GPT tạm khỏi điều phối voice; định nghĩa input/output và cách báo lỗi | Có thể thay GPT tạm bằng engine chính thức mà không sửa STT/TTS |
| TTS | Tích hợp ElevenLabs, approved voice và ngôn ngữ phiên; kiểm tra phát âm tiếng Việt/tên riêng | Audio có MIME/duration đúng trong envelope chung |
| Phát âm thanh | Bàn giao response/receipt và spec Stop/playback; frontend triển khai player, chống chồng tiếng và xử lý autoplay iPad | Chỉ phát lượt hợp lệ, receipt phản ánh phát thật |
| Điều phối lượt | Quản lý mã lượt, chuyển trạng thái, hủy lượt cũ khi có lượt mới và xử lý lỗi từng bước | Một pipeline có thể gọi từ giao diện hoặc dùng để kiểm thử |
| Tích hợp giao diện | Cung cấp thao tác bắt đầu/kết thúc thu, Stop và các sự kiện trạng thái; phối hợp với người làm frontend để nối UI | Giao diện biết khi nào đang nghe, xử lý, nói hoặc gặp lỗi |
| Cấu hình và tài liệu | Cấu hình model/voice/provider qua biến môi trường; giữ khóa API phía server; ghi cách chạy và kiểm thử | Hướng dẫn tích hợp, danh sách biến môi trường không chứa khóa thật |

GPT tạm nên trả lời theo vai Miu bằng 1–3 câu ngắn và tối đa một câu hỏi. Đây là cấu hình tối thiểu để kiểm thử voice; việc hoàn thiện chính sách trả lời và kiểm định an toàn thuộc engine chính thức.

## 4. Interface bàn giao với người làm engine

Hợp đồng dưới đây là interface adapter nội bộ Node/TypeScript; API browser đã theo [API contracts](api-contracts.md), không thêm ba route public cho STT/reply/TTS. Map `request_id`/`turn_id` của wire sang `turnId` nội bộ. Engine chính thức có thể thay GPT tạm qua adapter này.

| Chiều | Trường | Ý nghĩa |
| --- | --- | --- |
| Input | `turnId` | Map từ `request_id` do client tạo, giữ nguyên qua pipeline để đối chiếu và loại bỏ kết quả cũ |
| Input | `text` | Transcript đã nhận từ STT |
| Input | `language` | Ngôn ngữ trả lời đã xác định: `vi` hoặc `en` |
| Output | `turnId` | Giữ nguyên mã lượt đầu vào |
| Output | `replyText` | Lời thoại thuần văn bản đã sẵn sàng để đọc; không chứa Markdown, lệnh tool hoặc chỉ dẫn sân khấu |
| Output | `language` | Ngôn ngữ của câu trả lời, dùng để chọn giọng TTS phù hợp |

Voice pipeline chịu trách nhiệm truyền input, chờ output, kiểm tra output có hợp lệ để chuyển sang TTS và loại bỏ lượt đã hủy. Engine chính thức chịu trách nhiệm về nội dung câu trả lời và các kiểm tra nội dung trước khi trả `replyText`.

Cần thống nhất thêm với người làm engine: timeout, định dạng lỗi và cơ chế truyền tín hiệu hủy. Nếu engine chưa hỗ trợ hủy tác vụ, pipeline vẫn phải bỏ kết quả đến muộn. Không chuyển lỗi kỹ thuật hoặc câu trả lời rỗng vào TTS; dùng thông báo thử lại ngắn, phù hợp ngôn ngữ đang chọn.

Giai đoạn đầu dùng toàn bộ câu trả lời hoàn chỉnh rồi mới chạy TTS. Streaming audio, streaming text và tối ưu phát từng đoạn có thể làm sau khi luồng cơ bản ổn định.

## 5. Trạng thái và xử lý lỗi

Các trạng thái capture/playback để frontend tích hợp:

- `idle`: sẵn sàng, microphone tắt.
- `calibrating`: đang thu và đo mức nền ban đầu; hướng dẫn chờ trước khi nói.
- `recording`: đang thu âm theo thao tác Talk.
- `finalizing_capture`: đang chờ chunk audio cuối trước khi upload batch.
- `processing`: đang chờ response của turn endpoint; STT/GPT/TTS là stage nội bộ backend, không giả lập chuyển stage bằng timer trên UI.
- `speaking`: đang phát audio.
- `error`: lỗi có thể hiển thị hướng dẫn thử lại.

Stop đưa pipeline về trạng thái nghỉ sau khi dọn tài nguyên và vô hiệu hóa lượt hiện tại. Không tự mở lại microphone sau khi phát xong. Chỉ thao tác Talk chủ động mới được bắt đầu thu âm.

Xử lý ít nhất các trường hợp: người dùng từ chối microphone, không có tiếng nói/transcript rỗng, mạng gián đoạn, timeout hoặc lỗi provider, phản hồi GPT/engine không hợp lệ, lỗi tạo/phát audio và Stop ở giữa mỗi bước. Retry cùng request/body dùng cùng idempotency ID theo contract; ghi âm lại là lượt mới/ID mới. Stop hủy cục bộ và gọi cancel endpoint khi có lượt server, không khiến audio cũ phát chồng.

## 6. Ngoài phạm vi hiện tại

- Xây engine trả lời chính thức, logic hội thoại và bộ kiểm định nội dung đầy đủ.
- Memory, database ký ức, lịch sử hội thoại dài hạn, nhớ tên/sở thích, sửa hoặc quên thông tin.
- Personality/16 MBTI, mood, emotion, diary, relationship và lời hứa của Miu.
- Logic trò chơi, câu chuyện phân nhánh và checkpoint.
- Frontend responsive iPad, thiết kế giao diện, browser capture/player, vẽ nhân vật, animation hoặc lip-sync; phần voice bàn giao contract/cấu hình và phối hợp kiểm thử với người phụ trách frontend.
- Phân tích cảm xúc từ giọng nói, wake word và nghe nền.
- Realtime/streaming và các tối ưu nâng cao ngoài luồng batch đã chọn. Đo và tối ưu latency của batch thuộc phạm vi v1 theo D11-B.

## 7. Điều kiện hoàn thành phần việc

- [ ] Chạy được trọn vòng thu âm → STT → GPT tạm → TTS → phát audio.
- [ ] Thử thành công ít nhất 5 lượt tiếng Việt và 5 lượt tiếng Anh; kiểm tra cả transcript, nội dung và giọng đọc.
- [ ] GPT tạm không sử dụng memory hoặc lịch sử các lượt trước.
- [ ] Thay bộ sinh câu trả lời qua interface đã thống nhất mà không phải viết lại STT/TTS.
- [ ] Stop dừng thu âm/phát âm thanh; kết quả cũ không được phát sau khi hủy hoặc bắt đầu lượt mới. Mục tiêu theo đặc tả: dừng thu và âm thanh cục bộ trong 300 ms.
- [ ] Các lỗi chính có trạng thái rõ ràng và có thể bắt đầu lượt mới để thử lại.
- [ ] Microphone chỉ hoạt động khi người dùng chủ động thu âm; không lưu audio thô hoặc nội dung hội thoại vào log/file/database.
- [ ] Khóa API chỉ ở phía server và không được commit. Có tài liệu cấu hình, chạy thử và giới hạn hiện tại.
- [ ] Đo latency STT, GPT, TTS, flush/upload và audio bắt đầu thật trên iPad, không ghi nội dung vào số liệu. Mục tiêu tích hợp theo pipeline chung: p95 audio được duyệt bắt đầu ≤5 giây sau kết thúc thu một câu ngắn; báo median/p95 thực tế và lỗi trên 30 lượt mỗi ngôn ngữ/provider.

## 8. Thứ tự triển khai đề xuất

1. Chốt interface engine và cấu hình provider cần dùng.
2. Dựng STT riêng: audio đầu vào → transcript tiếng Việt/Anh.
3. Nối GPT tạm: transcript → câu trả lời ngắn, độc lập từng lượt.
4. Nối TTS và phát audio để hoàn thành một vòng thoại.
5. Hoàn thiện Stop, timeout, xử lý lỗi, trạng thái và tích hợp frontend.
6. Chạy các tình huống kiểm thử, đo độ trễ và bàn giao điểm nối cho người làm engine.

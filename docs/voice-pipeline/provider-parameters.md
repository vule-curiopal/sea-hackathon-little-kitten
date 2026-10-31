# Tham số provider và cấu hình pipeline

Tra cứu/cập nhật ngày **31/10/2026**. Đã chốt ElevenLabs STT batch/TTS, Node/TS backend, ngôn ngữ chọn trước phiên, GPT tạm `gpt-6-luna`, detector RMS và gửi nguyên blob từ iPad. Voice ID lấy từ bản local `D:/Intern/LittleBuddy_Implementation`, chi tiết tại [voices.md](voices.md). D10-C: tier/retention chưa rõ, xác minh trước real API; hiện chưa gọi API. Phân biệt **lựa chọn đã chốt**, **default provider**, **giá trị kỹ thuật đề xuất** và **trường không gửi**. Các tên dưới đây là wire HTTP; SDK có thể dùng tên khác.

## 1. Provider/model theo lựa chọn đã xác nhận

| Bước | Lựa chọn | Lý do / giới hạn |
| --- | --- | --- |
| STT batch | `scribe_v2` | Đường cơ bản cho một đoạn audio hoàn chỉnh |
| GPT tạm | `gpt-6-luna` qua Responses API, effort `none` | Chỉ sinh câu ngắn từ lượt hiện tại; phải kiểm tra quyền model của project |
| TTS | `eleven_flash_v2_5` | Có tiếng Việt và tiếng Anh, phù hợp thử đường thoại độ trễ thấp |

Không để TTS âm thầm dùng model mặc định `eleven_multilingual_v2`: danh sách ngôn ngữ của model đó không có tiếng Việt. Model/voice có thể được tài khoản cấp quyền khác nhau; phải kiểm tra thực tế trước khi chốt. Không coi thời gian model được quảng bá là latency toàn bộ ứng dụng. [ElevenLabs models](https://elevenlabs.io/docs/overview/models), [OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)

## 2. ElevenLabs STT batch — chế độ đã chốt

**POST `https://api.elevenlabs.io/v1/speech-to-text`**, multipart form, chỉ gọi từ backend. Trình tạo multipart tự đặt `Content-Type` kèm boundary. [API Create transcript](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)

### Các trường sử dụng hoặc cấu hình

| Vị trí | Tên API | Kiểu / miền giá trị | Đề xuất gửi |
| --- | --- | --- | --- |
| Header | `xi-api-key` | Secret string | Đọc từ env server |
| Query | `enable_logging` | Boolean; provider mặc định `true` | Theo D10, chỉ gửi `false` khi đã xác minh quyền/chế độ thực tế |
| Form | `model_id` | String, bắt buộc | `scribe_v2` |
| Form | `file` | Binary audio | Blob MediaRecorder nguyên bytes, MIME/tên file khớp container; MP4/AAC hoặc WebM/Opus theo capability iPad |
| Form | `file_format` | `pcm_s16le_16` hoặc `other` | `other` cho blob container v1; không gắn nhãn raw PCM cho WebM/MP4 |
| Form | `language_code` | ISO 639-1/639-3, tùy chọn | Gửi rõ `vi` hoặc `en` từ cấu hình phiên, theo D07-B; không auto-switch trong v1 |
| Form | `tag_audio_events` | Boolean; provider mặc định `true` | `false`, tránh đưa nhãn âm thanh vào GPT |
| Form | `diarize` | Boolean; mặc định `false` | `false`, không cần phân vai người nói |
| Form | `timestamps_granularity` | `none` / `word` / `character`; mặc định `word` | `none`; chỉ bật `word` cho debug có nhu cầu |
| Form | `temperature` | Số 0–2 | `0` |
| Form | `no_verbatim` | Boolean, dành cho Scribe v2 | `false`, giữ nguyên lời nói cho bước engine |
| Form | `use_multi_channel` | Boolean | `false`, đầu vào mono |
| Form | `webhook` | Boolean | `false`, cần kết quả ngay trong request |
| Form | `use_speaker_library` | Boolean | `false`, không nhận diện người nói |
| Form | `detect_speaker_roles` | Boolean | `false` |
| Form | `seed` | Integer 0–2147483647, tùy chọn | Bỏ qua; có thể cố định khi thử nhưng không bảo đảm tất định |
| Form | `keyterms` | List string, tối đa 1000; mỗi mục <50 ký tự, tối đa 5 từ | Bỏ qua lúc đầu; chỉ thuật ngữ demo tĩnh nếu đo cần |

`language_probability` là độ tin cậy nhận diện ngôn ngữ, không phải độ đúng transcript/tên riêng. Chuẩn hóa `vie`/`vi`, `eng`/`en` để chẩn đoán nhưng không dùng để ghi đè ngôn ngữ phiên D07-B. Session config ở server là nguồn quyết định tiếng STT/GPT/TTS; `language_hint` trong API chung không phải quyền override.

### Trường có trong API nhưng chưa sử dụng

Không gửi: query `token` (token một lần, chỉ cần nếu gọi trực tiếp từ browser); form `num_speakers`, `diarization_threshold`, `additional_formats`, `multichannel_output_style`, `source_url`, `cloud_storage_url` (deprecated), `webhook_id`, `webhook_metadata`, `transcript_edit`, `entity_detection`, `entity_redaction`, `entity_redaction_mode`. Các tính năng đó không cần cho một câu thoại mono của bản đầu. `num_speakers=1`/diarization không phải bộ lọc chọn người nói chính.

`keyterms` có phụ phí; không tự thêm tên cá nhân từ lịch sử. `transcript_edit` cũng có phụ phí và có thể thay chữ: không đưa vào baseline. Client/backend đồng bộ 30 giây/5 MiB audio, 6 MiB toàn multipart theo API chung; không dựa vào giới hạn upload lớn của provider để chặn request. MP4/M4A/AAC và WebM được liệt kê tại [supported STT formats](https://elevenlabs.io/docs/overview/capabilities/speech-to-text).

## 3. Batch hỗ trợ gì về VAD và giảm nhiễu?

Batch nhận một đoạn audio đã thu xong, không điều khiển microphone đang mở. API không công bố các trường `commit_strategy`, `vad_threshold`, `vad_silence_threshold_secs`, `min_speech_duration_ms`, `min_silence_duration_ms` hoặc `filter_background_audio` cho endpoint batch. Không gửi các trường đó vào `/v1/speech-to-text`. Đây là giới hạn hợp đồng API công khai, không khẳng định về thuật toán nội bộ của model. [STT batch reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)

| Nhu cầu | Hỗ trợ trong STT batch / nơi cần làm |
| --- | --- |
| Tự ngừng thu sau khoảng mức âm nhỏ | Detector RMS thích nghi trong ứng dụng hoặc nút Gửi; batch chỉ nhận sau đó |
| Bỏ lượt chưa có tín hiệu trước auto-upload | Logic mức âm cục bộ; có thể nhận nhầm tiếng ồn nên sau STT vẫn kiểm tra transcript rỗng |
| Khoảng đo nền, margin dB, min signal, thời gian dưới ngưỡng | Cấu hình client, không phải form fields của batch |
| Khử echo/noise suppression/auto gain của mic | Browser/hệ điều hành/phần cứng, không phải STT request |
| Nhận diện ngôn ngữ | Có, qua auto detection hoặc `language_code` |
| Thời gian các từ | Có, `timestamps_granularity`; phân tích audio đã gửi, không tự dừng mic |
| Phân biệt người nói | Có, `diarize` và các tùy chọn liên quan; không bảo đảm lọc chỉ người dùng chính |
| Nhãn tiếng cười/tiếng động | `tag_audio_events`; đánh nhãn, không khử tiếng ồn |
| Giảm nhiễu bổ sung trên file đã thu | Audio Isolation API riêng, ngoài phạm vi v1; không gọi trước STT |

### Audio Isolation — chỉ tham khảo, ngoài v1

**POST `https://api.elevenlabs.io/v1/audio-isolation`**, multipart. Endpoint riêng được tài liệu mô tả dùng để giảm background noise và tách vocals/speech từ audio. [Audio Isolation API](https://elevenlabs.io/docs/api-reference/audio-isolation/convert)

| Vị trí | Tham số | Nếu triển khai |
| --- | --- | --- |
| Header | `xi-api-key` | Khóa server |
| Form | `audio` | File audio của lượt, tên field khác STT (`file`) |
| Form | `file_format` | `pcm_s16le_16` cho raw PCM16LE mono 16 kHz; `other` cho container được hỗ trợ |
| Form | `preview_b64` | Không gửi, không cần preview |

V1 gửi audio đã thu thẳng vào STT batch. Bảng trên chỉ giữ làm tham khảo khả năng provider, không tạo bước isolation trong kế hoạch triển khai. Nếu mở rộng ở đợt sau phải kiểm tra định dạng output trước khi gửi STT.

Việc cân nhắc ở đợt sau cần đo chất lượng, độ trễ/chi phí và chính sách dữ liệu. Isolation không phải cơ chế dừng mic và không bảo đảm loại bỏ giọng người nói bên cạnh.

## 4. ElevenLabs TTS

**POST `https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`**, JSON body. Nhận toàn bộ audio rồi phát; input là lời thoại hoàn chỉnh đã kiểm tra. [API Create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)

### Request chính

| Vị trí | Trường | Đề xuất |
| --- | --- | --- |
| Path | `voice_id` | Theo allowlist [voices.md](voices.md); mặc định `vi=mgBpvrNosWzExdPuRbXP`, `en=fBD19tfE58bkETeiwUoC` |
| Header | `xi-api-key` | Secret server |
| Header | `Content-Type` | `application/json` |
| Query | `output_format` | `mp3_44100_128`; backend bọc vào `audio.data_base64`, `audio.mime_type=audio/mpeg` theo envelope chung |
| Query | `enable_logging` | Theo D10; mặc định provider là `true` |
| Body | `text` | `replyText` sau kiểm tra, không gửi transcript người dùng vào TTS |
| Body | `model_id` | `eleven_flash_v2_5`, luôn gửi rõ |
| Body | `language_code` | `vi` / `en` từ cấu hình phiên; reply cần khớp cùng tiếng trước TTS |
| Body | `apply_text_normalization` | `auto`; nghe thử số, ngày, tên riêng trước khi đổi `on`/`off` |
| Body | `apply_language_text_normalization` | `false`; không bật cho Việt/Anh |
| Body | `voice_settings` | Object như bảng dưới, áp dụng riêng request |

```json
{
  "text": "<lời thoại đã được kiểm tra>",
  "model_id": "eleven_flash_v2_5",
  "language_code": "vi",
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0,
    "use_speaker_boost": false,
    "speed": 0.95
  },
  "apply_text_normalization": "auto",
  "apply_language_text_normalization": false
}
```

### Giọng và cách đọc

| Trường `voice_settings` | Giá trị đề xuất | Cách chọn |
| --- | --- | --- |
| `stability` | `0.50` trong [0, 1] | Thấp hơn cho biến thiên nhiều, cao hơn cho giọng ổn định |
| `similarity_boost` | `0.75` trong [0, 1] | Độ gần giọng gốc; không phải độ lớn âm thanh |
| `style` | `0` | Bắt đầu ít cường điệu, đo trước khi tăng |
| `use_speaker_boost` | `false` | So sánh chất lượng/độ trễ nếu cần bật |
| `speed` | `0.95` | Thử tốc độ dễ nghe; 1 là bình thường, không phải pitch |
| `clone_strength` | Không gửi | Không dùng professional clone/v4 trong baseline |

Nguồn mô tả các thiết lập: [Default voice settings API](https://elevenlabs.io/docs/api-reference/voices/settings/get-default). Đây là giá trị dự án; ví dụ `use_speaker_boost=false` không phải default provider.

### Trường TTS tùy chọn chưa dùng

| Trường | Xử lý bản đầu |
| --- | --- |
| Query `optimize_streaming_latency` | Không gửi, đã deprecated |
| `pronunciation_dictionary_locators` | Không gửi; nếu bổ sung thì chỉ dictionary tĩnh đã kiểm thử, tối đa 3 locator `pronunciation_dictionary_id` + `version_id` theo schema |
| `seed` | Bỏ qua; khi đo có thể dùng integer 0–4294967295, không bảo đảm tất định |
| `previous_text`, `next_text` | Không gửi; không nối lời thoại giữa các lượt |
| `previous_request_ids`, `next_request_ids` | Không gửi; không request stitching |
| `use_pvc_as_ivc` | Không gửi; không cấu hình clone |
| `audio_effects` | Không gửi; không thêm reverb/tiếng nền vào giọng nói |

Nếu sau này dùng `audio_effects`, các trường gồm `filter_preset_id`, `distance`, `environment_id`, `background_noise_id`, `send_level`, `pan`; baseline không gửi trường nào. Các hiệu ứng này thuộc **audio đầu ra**, không khử tạp âm microphone. Không tạo tham số `pitch`, `emotion`, `noiseSuppression`, `silenceTimeout` vào request TTS vì các mục đó không thuộc hợp đồng TTS đang chọn.

MP3 44,1 kHz đầu ra không yêu cầu mic đầu vào 44,1 kHz. Nếu đổi sang raw PCM TTS, cần player PCM/AudioContext biết sample rate; không đưa bytes PCM trực tiếp cho player MP3. Một số output format/chức năng có giới hạn gói tài khoản; xác minh trước khi thay format.

## 5. GPT tạm qua OpenAI Responses API

**POST `https://api.openai.com/v1/responses`**, dùng SDK phía server. Tham số và cấu trúc Responses: [official OpenAI API reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create).

| Trường | Giá trị đề xuất |
| --- | --- |
| Header `Authorization` | `Bearer` + OpenAI key server |
| `model` | `OPENAI_MODEL=gpt-6-luna`, D09-A đã xác nhận; quyền project vẫn cần kiểm tra |
| `instructions` | Miu là mèo AI; trả lời đúng `replyLanguage`; 1–3 câu ngắn, tối đa 1 câu hỏi, lời nói thuần; không hứa hành động ngoài app |
| `input` | Chỉ transcript của lượt hiện tại, đặt ở user input |
| `reasoning` | `{ "effort": "none" }` với model đề xuất đã hỗ trợ mức này |
| `max_output_tokens` | `200`, giới hạn token, không tự bảo đảm số câu |
| `store` | `false` |
| `stream` | `false` |
| `tools` | `[]` |
| `previous_response_id`, `conversation` | Không gửi |
| `temperature`, `top_p` | Không gửi trong baseline; kiểm tra tương thích nếu đổi model |

Lấy text bằng helper SDK hoặc parse output text đúng kiểu. Nếu response không hoàn tất, bị cắt bởi token limit, có refusal, text rỗng, Markdown/lệnh/nhãn không phù hợp hoặc vượt giới hạn lời thoại thì dùng fallback, không chuyển mù sang TTS. Prompt không thay thế engine kiểm định nội dung của team.

`store=false` và bỏ conversation giúp ứng dụng không dùng lại lượt trước; **không tuyên bố đây là zero retention toàn bộ dịch vụ**. Kiểm tra điều kiện dữ liệu provider trước khi có dữ liệu trẻ em thật; hiện chỉ thử với người lớn và dữ liệu giả.

## 6. Cấu hình server và timeout đề xuất

Các tên UPPERCASE bên dưới là **tên env dự kiến của dự án**, không phải API fields. File `.env` thật không được commit. `deviceId` là lựa chọn phiên trên browser, không phải env server.

| Nhóm | Tên env / cấu hình | Khởi điểm |
| --- | --- | --- |
| Secret | `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` | Cung cấp ở server, không đặt tiền tố public/VITE |
| Chế độ chung | `MIU_PROVIDER` | `fake` trong lúc D10 chưa xác minh; real mode dùng cùng hợp đồng, không thêm memory cho GPT tạm |
| ElevenLabs | `ELEVENLABS_BASE_URL` | `https://api.elevenlabs.io`; chỉ allowlist host provider |
| STT | `VOICE_STT_MODE`, `ELEVENLABS_STT_MODEL` | `batch`, `scribe_v2` |
| TTS | `ELEVENLABS_TTS_MODEL` | `eleven_flash_v2_5` |
| Voice | `ELEVENLABS_VOICE_ID_VI`, `ELEVENLABS_VOICE_ID_EN` | `mgBpvrNosWzExdPuRbXP`, `fBD19tfE58bkETeiwUoC`; kế thừa mặc định Việt/Anh của bản local |
| Logging provider | `ELEVENLABS_ENABLE_LOGGING` | D10-C: tier/chính sách chưa rõ; cần xác minh trước real mode, không tự coi false hoặc mặc định true là đã được duyệt |
| GPT | `OPENAI_MODEL`, `OPENAI_MAX_OUTPUT_TOKENS` | `gpt-6-luna`, `200` |
| Timeout STT | `STT_TIMEOUT_MS` | `10000` sau khi bắt đầu request |
| Timeout GPT | `REPLY_TIMEOUT_MS` | `10000` |
| Timeout TTS | `TTS_TIMEOUT_MS` | `10000` để nhận audio bản non-streaming |
| Toàn lượt sau gửi | `TURN_PROCESSING_TIMEOUT_MS` | `20000`, ưu tiên hơn tổng timeout stage |
| Retry | `PROVIDER_MAX_RETRIES` | `0` trong baseline; tắt retry ẩn của SDK |
| Payload | `MAX_AUDIO_BYTES`, `MAX_REQUEST_BYTES`, `MAX_TRANSCRIPT_CHARS`, `MAX_REPLY_CHARS` | `5242880`, `6291456`, `2000`, `400`; thống nhất API chung |
| Browser origin | `ALLOWED_ORIGINS` | Origin frontend cụ thể cho môi trường chạy |

Timeout là giới hạn lỗi, không phải mục tiêu latency. Nếu chọn retry sau này: tối đa 1 lần cho lỗi phù hợp, tôn trọng `Retry-After`, remaining deadline và signal; không tự retry auth/quota/schema, không retry audio đã bắt đầu phát. Abort request không bảo đảm provider chưa xử lý hoặc chưa tính phí.

D11-B ưu tiên latency trong phạm vi batch: server gọi adapters trong một request turn, giữ client/kết nối provider khi được hỗ trợ, gửi container gốc nhỏ và lời thoại ngắn. Chưa chạy benchmark hoặc đổi các mốc 1.500/5.000/30.000 ms đã chọn. Mục tiêu tích hợp p95 ≤5 giây sau kết thúc thu, đo 30 câu ngắn mỗi ngôn ngữ/provider theo pipeline chung; đo latency thực theo stage thay vì coi timeout 10/20 giây là đạt yêu cầu.

Microphone constraints, calibration, RMS/noise floor, margin, thời gian dừng và recorder MIME nằm ở client config trong [microphone-vad.md](microphone-vad.md). Không đưa các trường đó vào form ElevenLabs, không đưa toàn bộ env backend xuống browser. V1 không có config model VAD hoặc PCM encoder.

Hai biến voice env chỉ là mặc định server theo tiếng. Cấu hình public vẫn dùng trường `voice_id` hiện có; server resolve mặc định/override hợp lệ từ allowlist theo `language_mode`, không thêm hai field voice theo tiếng vào API.

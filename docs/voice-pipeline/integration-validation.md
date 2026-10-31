# Tích hợp API chung và kiểm thử voice trên iPad

Trạng thái: backend dùng **Express 5 + TypeScript trên Node.js** và browser library cho frontend React/TypeScript, theo [API contracts](../api-contracts.md). Express routes/controllers gọi TurnService và SessionService/repository; provider adapters tách riêng, xem [kiến trúc backend](backend-architecture.md). STT/TTS ElevenLabs batch, detector RMS thích nghi và ngôn ngữ chọn trước phiên đã có code/tests; [trạng thái bàn giao](implementation-status.md) ghi rõ phần chưa kiểm thử thật.

Phần frontend responsive do thành viên khác phụ trách. Phần voice bàn giao controller, yêu cầu microphone/playback, kiểu dữ liệu và kiểm thử tích hợp; không nhận thiết kế UI sản phẩm. Khóa provider luôn ở server.

## 1. Một request hoàn chỉnh cho một lượt

| Route theo API contract | Dùng trong voice |
| --- | --- |
| `POST /api/sessions` | Nhận session, demo token, cấu hình hiệu lực và versions theo orchestrator chung |
| `PATCH /api/profiles/current/config` | Chọn `language_mode=vi` hoặc `en` và voice hợp lệ trước lượt đầu; không sửa giữa lượt |
| `POST /api/sessions/{session_id}/turns` | Upload một blob hoàn chỉnh; server chạy STT → response adapter → validation → TTS rồi trả một JSON envelope |
| `DELETE /api/sessions/{session_id}/turns/{turn_id}` | Hủy lượt phía server, song song với dừng audio/mic cục bộ |
| `POST /api/sessions/{session_id}/turns/{turn_id}/playback` | Gửi receipt `started`, `completed`, `interrupted` theo trạng thái playback thật |
| `DELETE /api/sessions/{session_id}` | Kết thúc phiên và hủy công việc còn chờ theo orchestrator chung |

Multipart turn dùng `request_id`, `kind=utterance`, `audio`, `language_hint=vi|en` khớp cấu hình phiên; `fixture_id` chỉ có trong fake mode. `turn_id=request_id`, là UUID do client tạo. Token lấy từ session setup, không suy ra từ transcript. Chỉ gửi blob sau khi recorder đã flush chunk cuối; không upload từng chunk khi đang thu.

Giới hạn đồng bộ client/server: **30 giây ghi âm**, **5 MiB audio**, **6 MiB toàn multipart**. Duration bao gồm calibration. Nhận MP4/AAC (kể cả M4A), WebM/Opus hoặc WAV thực sự hợp lệ; dùng MIME thật từ MediaRecorder, không đoán bằng tên thiết bị. Backend probe container/metadata trong giới hạn tài nguyên, rồi forward nguyên bytes tới ElevenLabs batch bằng `file_format=other`; không resample, PCM encode hoặc Audio Isolation trong v1.

Response dùng schema chung: `session_id`, `turn_id`, versions, `reply`, `audio`, presentation/face và trạng thái do các module sở hữu cung cấp. `audio.data_base64` là audio hoàn chỉnh; `audio.mime_type=audio/mpeg` cho MP3 ElevenLabs, có thể `audio/wav` với fixture WAV. Không có binary response riêng hay `X-Turn-Id` thay cho envelope.

Phần voice không tạo profile/character/memory giả để điền schema. Adapter GPT tạm cung cấp lời thoại, TTS cung cấp bytes/duration; orchestrator chung lắp envelope và quản lý những field còn lại. Nếu module của người khác chưa sẵn sàng, dùng fixture tích hợp có ghi rõ mode và giới hạn, không báo một thao tác nhớ/learn đã thành công. Trạng thái request, cancellation và idempotency trong RAM là dữ liệu giao thức, không phải memory hội thoại.

## 2. Interface nội bộ và GPT tạm

Các bước STT/reply/TTS là adapter nội bộ được `TurnService` gọi trên server Node.js. Controller chỉ map HTTP, xác thực và nối transport abort; service không nhận Express request/response. Contract reply cốt lõi:

```ts
type Language = "vi" | "en";
type ReplyInput = { turnId: string; text: string; language: Language };
type ReplyOutput = { turnId: string; replyText: string; language: Language };

interface ResponseGenerator {
  generate(input: ReplyInput, signal: AbortSignal): Promise<ReplyOutput>;
}
```

`signal` ở trong process, không serialize thành JSON. Orchestrator map wire `request_id` sang `turnId` nội bộ. Thay GPT tạm bằng engine chính thức chỉ thay adapter, giữ nguyên endpoint/envelope/STT/TTS. Adapter bên ngoài nếu có phải dùng URL được cấu hình server, không lấy URL từ input người dùng.

GPT tạm dùng model đã chọn ở D09, chỉ transcript hiện tại + hướng dẫn cố định, không conversation ID, previous response ID hoặc lịch sử lượt trước. `store=false`, không tool. Validate schema, text rỗng/quá dài/incomplete, ngôn ngữ và định dạng lời nói trước TTS. Bộ kiểm định nội dung/character đầy đủ thuộc engine của team; prompt tạm không được trình bày như engine đó đã hoàn thành.

D10 cập nhật theo yêu cầu dùng brain đang hoạt động: `STT_LOGGING=1` mặc định, bỏ query logging cho STT; TTS cũng không gửi query này. `0` yêu cầu STT ZRM bằng `enable_logging=false` và đang nhận HTTP 403 trên tài khoản hiện tại, trong khi STT normal trả 200. Đây là dữ liệu phía provider, không thay đổi tính stateless của GPT hoặc quy tắc không log nội dung tại ứng dụng. Tier/thời hạn retention cụ thể vẫn chưa được xác nhận; không tuyên bố zero retention. Xem [D10](decisions.md#d10--logging-theo-littlebuddy-brain).

## 3. Ngôn ngữ đã chọn trước phiên

D07-B: frontend cho chọn **Việt hoặc Anh trước mỗi phiên thử**, map sang `language_mode=vi|en`. Server lấy cấu hình đã xác thực để đặt `language_code` cho STT, ngôn ngữ GPT, fallback và TTS; `language_hint` chỉ là hint cùng giá trị, không ghi đè cấu hình.

Không tự chuyển tiếng theo một transcript ngắn hoặc mixed. Nếu input không rõ/khác kỳ vọng thì hỏi lại bằng ngôn ngữ phiên hoặc báo nhận dạng chưa rõ; giữ nguyên tên riêng. Đổi lựa chọn chỉ khi hết lượt hiện tại và cập nhật cấu hình/phiên theo contract. Bộ chọn ngôn ngữ và layout responsive do frontend thực hiện; voice bàn giao mapping và điều kiện không đổi giữa lượt.

## 4. iPad và các yêu cầu bàn giao cho frontend

- Kiểm thử trên iPad thật, bắt đầu với Safari làm mốc kiểm thử; ghi model iPad/iPadOS/browser thực tế, không mặc định thiết bị nào cũng có cùng codec. Kiểm tra `MediaRecorder.isTypeSupported()` và `recorder.mimeType`; MP4/AAC là đường cần hỗ trợ, WebM/Opus dùng khi capability thật cho phép. [WebKit MediaRecorder](https://webkit.org/blog/11353/mediarecorder-api/), [Safari 18.4 codec updates](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)
- Trang demo phải là secure context. iPad truy cập HTTP IP LAN của laptop không được hưởng ngoại lệ localhost của chính laptop; chuẩn bị URL HTTPS với chứng chỉ được thiết bị tin cậy. Không yêu cầu người dùng tắt bảo vệ browser. [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- Talk là thao tác người dùng cho phép mở mic và tạo/resume AudioContext; chờ trạng thái chạy thực trước khi đo RMS. Không coi dữ liệu meter chưa chạy là im lặng. [AudioContext.resume](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume)
- Sau async request, `play()` vẫn có thể bị chặn: xử lý Promise rejection và hiện nút Phát chủ động cho đúng lượt còn hiệu lực. Chỉ gửi receipt `started` khi audio thật sự phát; không đánh dấu hoàn tất khi play bị từ chối. [HTMLMediaElement.play](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)
- Tab ẩn, khóa màn hình, đổi app, stream kết thúc hoặc AudioContext suspend giữa lượt thì hủy, cleanup, không tự thu/phát lại khi quay về.
- Frontend bảo đảm Talk/Gửi/Stop và chọn ngôn ngữ dùng được ở dọc/ngang và split view, không tràn ngang, touch target tối thiểu 48 CSS px, focus/keyboard rõ, caption/fallback và reduced motion. Voice cung cấp state và hành vi, frontend sở hữu bố cục.

Các điểm trên là yêu cầu kiểm thử, chưa phải kết quả chứng minh tương thích iPad. Chưa có số phiên bản iPadOS/browser và môi trường phòng demo cụ thể; ghi nhận khi thử thật, không chặn các phần công việc không phụ thuộc thông tin đó.

## 5. State machine và hủy

```text
idle → requesting_permission → calibrating → recording
     → finalizing_capture → processing → speaking → idle

Gửi/detector/max duration → cùng finalizeCapture(reason), chốt một lần
Stop/Hủy/tab ẩn/đổi mic → invalidate → cleanup → idle
Lỗi → cleanup → error; thao tác người dùng mới tạo lượt mới
```

`processing` bao gồm các stage STT/generate/validate/TTS trên server. Một response batch không cung cấp tiến trình từng stage cho browser; UI hiển thị đang xử lý, không giả lập rằng STT vừa xong hay TTS đã bắt đầu. Timing từng stage xuất hiện khi response hoàn tất.

MediaRecorder bắt đầu ngay khi mic sẵn sàng, UI báo đo nền (đề xuất 750 ms) rồi mời nói. Initial wait **5.000 ms** tính sau calibration; im lặng kết thúc **1.500 ms**; giới hạn cứng **30.000 ms** tính từ lúc recorder bắt đầu. Detector ghi nhận mức âm chứ không xác nhận nội dung giọng nói; ngưỡng sai có thể cần Gửi thủ công/thu lại. Chi tiết ở [microphone-vad.md](microphone-vad.md).

Mỗi lượt có request ID, generation counter và AbortController. Gửi thủ công có thể vượt qua detector khi blob hợp lệ; auto-submit cần `hasSignal`. Khi submit, chờ `dataavailable` cuối và `stop` trước upload. Khi cancel, các event đó vẫn có thể tới nhưng không được upload.

Stop thực hiện ngay ở client rồi gửi hủy server:

1. Invalidate generation trước khi stop recorder/abort vì callback có thể tới muộn.
2. Dừng recorder, tracks, meter/timer, AudioContext; bỏ chunk; dừng audio và revoke object URL.
3. Abort request turn đang chờ; dùng request độc lập gọi route DELETE cùng `turn_id` nếu lượt đã được gửi. Không dùng signal đã abort cho chính request hủy.
4. Server giữ cancellation/idempotency metadata ngắn hạn để DELETE đến trước POST cũng không cho upload cũ khởi động lại. Các handler nối AbortSignal/deadline với provider, bỏ output stale.
5. Kiểm tra generation, session và versions trước decode/play. Nếu đang phát thật thì gửi receipt `interrupted`; không gửi `completed` cho lượt đã hủy.

Abort transport không thay cho API hủy và không bảo đảm provider chưa xử lý/tính phí. Nếu server còn lượt cũ, nhận `409 turn_in_progress` và xử lý theo contract, không tự chồng lượt. Dừng mic/âm thanh local có mục tiêu **≤300 ms**; không chờ round trip DELETE mới dừng local.

## 6. Idempotency, lỗi và playback

Giữ nguyên request ID cho retry **cùng body** theo API contract. Nếu người dùng thu âm lại thì tạo request ID mới; không phát lại request/audio cũ trong nền. Tắt retry ẩn của SDK; không tự retry auth/quota/schema. `409 idempotency_conflict` là lỗi hợp đồng cần xử lý, không đổi ID tự động để che request khác body.

Lỗi server dùng schema chung `{error:{code,message,retryable},turn_id}` và các status trong API contracts. Lỗi local như mic bị từ chối, meter không chạy, không có tín hiệu hoặc play bị chặn chỉ là state/error của controller, không tạo schema HTTP khác.

| Trường hợp | Hành vi |
| --- | --- |
| Mic bị từ chối/không có mic | Hướng dẫn cấp quyền/chọn mic; không gọi provider |
| Meter lỗi, recorder còn tốt | Tắt auto-submit, cho Gửi thủ công; giữ Stop và giới hạn cứng |
| Hết initial wait chưa có tín hiệu | Bỏ audio và đóng mic; không auto-upload |
| STT trả rỗng/không rõ | Không gọi GPT; lỗi/fallback theo contract, không bịa lời đã nghe |
| Format/size không hợp lệ | `413`/`415`; dừng trước provider |
| Provider timeout/quota/auth hoặc output không hợp lệ | Lỗi chuẩn; không đọc exception hoặc payload provider ra loa |
| Canceled/stale | Bỏ output; không phát fallback re-engagement |
| Playback bị chặn | Nút Phát chủ động; không mở mic hoặc báo đã phát xong |

Response transcript/reply/audio dùng `Cache-Control: no-store`; không log secret, audio, transcript hoặc raw provider response. Caption lỗi dùng ngôn ngữ phiên. Fallback khi TTS hỏng không phụ thuộc chính TTS đang lỗi: dùng caption hoặc clip tĩnh được duyệt.

Receipt `started/completed/interrupted` dùng ID riêng và trạng thái thật theo contract. Voice chỉ báo điều đã phát; engine/memory phía orchestrator quyết định xử lý học/quan hệ. Không biến receipt thành xác nhận đã lưu ký ức của bot tạm.

## 7. Kiểm thử khi triển khai

Đã có 139 test tự động cho backend/provider và browser library, cùng fake smoke Việt/Anh. HTTP localhost dùng frontend API client với runtime Node HTTP/Express; request provider trong tests đều mocked. Probe riêng đã chạy STT → GPT → TTS thật cho Việt/Anh trên máy phát triển và server, nhận MP3 hợp lệ. Đây là các lượt đơn lẻ, chưa kiểm thử mic/playback trên iPad hoặc đo p95. Xem [trạng thái triển khai](implementation-status.md).

| Nhóm | Ca cần thử | Điều kiện đánh giá |
| --- | --- | --- |
| iPad HTTPS/mic | Cấp/từ chối quyền, rút/chuyển mic, mất secure context | Có hướng dẫn, không rò track; Talk lại được |
| MIME | MP4/AAC và WebM khi được hỗ trợ, chunk cuối, blob rỗng/sai nhãn | Forward đúng bytes, `file_format=other`; reject format lạ |
| RMS/calibration | Nền yên/ồn, nói ngay, nói nhỏ, click, quạt, người bên cạnh, AGC | Đo nhận nhầm/bỏ sót; không khẳng định phân biệt được mọi tiếng nền |
| Câu ngắn/ngập ngừng | “ừ/yes/no”, pause 0,5/1/1,5/2 giây | Không bỏ câu hợp lệ; ghi rõ điểm cắt và tune |
| Timer | 5 giây chưa nói; 1,5 giây dưới ngưỡng; 30 giây thu; callback trễ | Chốt một lần, không tính gap suspend là silence |
| Race/Stop | Gửi + detector + timeout; Stop khi flush/upload/chờ provider/decode/play | Không gửi/phát stale; local stop ≤300 ms; DELETE đúng lượt |
| Protocol | Retry cùng ID/body, body khác, cancel trước POST, 409 active turn | Theo idempotency/cancel contract; không state chồng |
| Ngôn ngữ | Phiên Việt và phiên Anh, câu mixed/tên riêng | Không tự đổi mode; STT/reply/TTS/fallback khớp cấu hình |
| iPad playback/UI | Play rejection, portrait/landscape/split view, background/lock | Receipt phản ánh thật; nút phục hồi; responsive do frontend |
| Không memory | Hai lượt, reload, kiểm tra payload GPT/log | Chỉ lượt hiện tại; không lưu nội dung hoặc dựng memory giả |
| Engine | Thay GPT adapter bằng engine/fake, sai schema/language/timeout | Endpoint/STT/TTS giữ nguyên, lỗi/hủy đúng |
| Provider lỗi | Timeout, mạng mất, 401/403/429/5xx | Lỗi chuẩn, không retry ẩn hoặc đọc lỗi kỹ thuật |
| Logging STT | Mặc định/`1`, explicit `0`, alias cũ và cờ mâu thuẫn | Normal không có query; `0` chỉ gửi `enable_logging=false` cho STT; TTS không có query; cấu hình mâu thuẫn bị từ chối; không fallback ZRM sang normal |

Tự động kiểm tra phần dễ gây chi phí/state sai: adaptive threshold không học tiếng đang nói, clock/timer, flush-before-upload, finalize một lần, cancel race/idempotency, mapping container/provider, output incomplete và error mapping. Chất lượng mic/STT/giọng đọc cần iPad thật và người kiểm thử, không thay bằng snapshot cấu hình.

## 8. Đo latency và bàn giao

Mục tiêu acceptance chung: **p95 audio trả lời được duyệt bắt đầu phát ≤5 giây sau khi kết thúc thu một câu ngắn**, đo 30 lượt mỗi ngôn ngữ/provider theo [pipeline](../pipeline.md). Đây là mục tiêu chưa đo; dùng làm mốc cho tích hợp, báo median/p95 và số thất bại thực tế riêng.

| Số đo | Mốc |
| --- | --- |
| `endpointingMs` | Âm nói cuối theo tham chiếu → quyết định kết thúc thu; mốc dưới ngưỡng chỉ là ước lượng |
| `recordingEndToAudioStartMs` | Kết thúc thu → flush cuối + upload + server + decode + audio bắt đầu thật; đối chiếu 5 giây |
| `perceivedResponseMs` | Từ lúc nói xong thật đến audio đầu; gồm cả khoảng đợi im lặng |
| `recorderFlushMs` | Gọi stop recorder → blob hoàn chỉnh |
| `timings_ms.stt/reply/tts/server_total` | Đo từng stage bằng clock server, nằm trong envelope chung |
| `stopLocalMs` | Bấm Stop → capture/playback local dừng |

Dùng clock đơn điệu, không trừ hai clock máy khác nhau. Kiểm tra 30 lượt mỗi ngôn ngữ trên mạng/iPad demo, phân biệt cold/warm start và fake/real. Báo số lượt lỗi/timeouts, codec, kích thước blob, browser/iPadOS, cấu hình ngưỡng; không loại lỗi khỏi báo cáo. Theo D11-B, tối ưu connection reuse, blob/container, độ dài reply và TTS trong luồng batch; không đổi sang realtime hoặc giảm khoảng dừng đã chốt chỉ để đạt số đo.

Bàn giao cho frontend: library `@miu/voice-client` với controller, state/error mapping, request/envelope và receipt mẫu, cleanup/cancel, MIME và checklist iPad/responsive. Bàn giao cho engine: interface adapter nội bộ và cách thay GPT tạm. Bàn giao vận hành: env example, [kiến trúc Express](backend-architecture.md), runtime listen/close, hướng dẫn chạy/test và normal mode theo brain ở D10. Test tự động dùng fake/mocked provider; probe thật Việt/Anh được ghi riêng trong [trạng thái triển khai](implementation-status.md). Bộ [20 audio đầu vào](../../test-assets/voice-pipeline/README.md) được tạo bằng job TTS riêng. Frontend/API đã được triển khai chung tại `https://miu.curiopal.com`; thiết kế UI vẫn thuộc người phụ trách frontend, checklist iPad và benchmark vẫn cần nghiệm thu.

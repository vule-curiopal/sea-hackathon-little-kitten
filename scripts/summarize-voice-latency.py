"""Summarize measured JSON, without reading credentials or calling providers."""
from pathlib import Path
import json
import statistics
import sys

report_path = Path(sys.argv[1]).resolve()
report = json.loads(report_path.read_text(encoding='utf-8'))
if report.get('run_kind') == 'calibration':
    raise SystemExit('Calibration runs must not be used as complete DB measurements.')

def union(spans):
    total, end = 0.0, float('-inf')
    for start, finish in sorted(spans):
        if finish > end:
            total += finish - max(start, end)
            end = finish
    return total

successful = []
for row in report['assets']:
    if row['status'] != 'completed':
        continue
    start, finish = row['transcript_final_ms'], row['result_ms']
    def clip(spans):
        return [(max(start,a), min(finish,b)) for a,b in spans if min(finish,b)>max(start,a)]
    db = clip([(q['start_ms'],q['end_ms']) for q in row['database']+row.get('transactions',[])])
    tts = clip([(row['tts_start_ms'],row['tts_end_ms'])])
    # Use unions measured inside the runner on its own monotonic clock.
    # All model calls belong to the engine span. Memory transactions do not await model calls.
    detail = row['engine_detail']
    model_ms = detail['model_union_ms']
    overlap = max(0,model_ms+detail['database_union_ms']-detail['model_and_database_union_ms'])
    parts = {
        'endpoint_wait_ms': row['metrics']['endpoint_after_speech_ms'],
        'finalize_drain_ms': row['metrics']['finalize_drain_ms'],
        'database_ms': union(db)-overlap,
        'model_api_ms': model_ms-overlap,
        'tts_ms': union(tts),
        'other_ms': finish-start-union(db)-model_ms-union(tts)+2*overlap,
    }
    # DB/model overlap is assigned to Other to keep the critical path additive.
    total = sum(parts.values())
    assert abs(total-row['metrics']['speech_end_to_mp3_received_ms']) < 5, row['id']
    processing_queries = [q for q in row['database'] if q['start_ms']>=start and q['end_ms']<=finish]
    successful.append({'id':row['id'],**parts,'total_ms':total,
        'profile_setup_ms':row['metrics']['profile_setup_ms'],
        'stream_connect_ms':row['metrics']['stream_connect_ms'],
        'engine_ms':row['metrics']['engine_ms'],
        'processing_sql_queries':len(processing_queries),
        'model_requests':len(row['model_requests']),
        'outside_engine_database_ms':row['pipeline_database_detail']['before_engine_union_ms']+row['pipeline_database_detail']['after_engine_union_ms'],
    })
assert successful, 'No successful measured turns'
keys = ['endpoint_wait_ms','finalize_drain_ms','database_ms','model_api_ms','tts_ms','other_ms','total_ms',
        'profile_setup_ms','stream_connect_ms','engine_ms','processing_sql_queries','model_requests','outside_engine_database_ms']
summary = {key:{'median':round(statistics.median(r[key] for r in successful),1),
                'mean':round(statistics.mean(r[key] for r in successful),1),
                'min':round(min(r[key] for r in successful),1),'max':round(max(r[key] for r in successful),1)} for key in keys}
stages = {}
for row in report['assets']:
    if row['status'] != 'completed':continue
    for request in row['model_requests']:
        stages.setdefault(request['stage'],[]).append(request['elapsedMs'])
stage_summary={key:{'requests':len(values),'median_ms':round(statistics.median(values),1),'max_ms':round(max(values),1)} for key,values in stages.items()}
result={'scope':report['scope'],'successful_turns':len(successful),'attempted':len(report['assets']),
        'summary':summary,'model_stages':stage_summary,'assets':successful}
report_path.with_name('summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

labels={'endpoint_wait_ms':'Chờ VAD sau lời cuối','finalize_drain_ms':'Flush/chốt transcript cuối',
        'database_ms':'Database và transaction','model_api_ms':'Các API model (không cộng trùng chạy song song)',
        'tts_ms':'TTS adapter, gồm kiểm tra MP3','other_ms':'Xử lý/transport còn lại','total_ms':'Tổng từ lời cuối đến nhận MP3'}
lines=['# Đo độ trễ voice realtime','',
       'Đo trên app local, engine nhân vật/trí nhớ thật và PostgreSQL từ xa qua SSH tunnel; VAD chờ 3 giây. '
       'Mỗi lượt chỉ bàn giao full transcript một lần cho engine, nhưng engine có nhiều API model nội bộ. '
       'Dùng schema test riêng; không dùng các hồ sơ production.', '',
       f"Đã thử **{len(report['assets'])} file**: **{len(successful)} lượt có MP3**, "
       f"**{report['summary']['rejected']} bị chặn trước engine** và **{report['summary']['failed']} lượt thất bại**. "
       f"Schema test đã xóa: **{report['schema_removed']}**.", '',
       '## Thời gian sau lời nói cuối', '',
       '| Thành phần | Trung vị (giây) | Khoảng min–max (giây) |','| --- | ---: | ---: |']
for key,label in labels.items():
    item=summary[key];lines.append(f"| {label} | {item['median']/1000:.2f} | {item['min']/1000:.2f}–{item['max']/1000:.2f} |")
lines += ['', 'Các trung vị theo cột không nhất thiết cộng thành trung vị tổng. Biểu đồ dùng phân rã từng lượt có thể cộng được. '
          'Phần chồng lấp model/DB được tính vào “còn lại”; thời gian từng truy vấn trong transaction có thể gồm chờ hàng đợi, nên dùng union của các khoảng thời gian.', '',
          '![Phân rã độ trễ từng file](latency.png)', '',
          '## Điểm đang tốn thời gian nhất', '',
          f"- Database/transaction chiếm trung bình **{summary['database_ms']['mean']/summary['total_ms']['mean']*100:.1f}%** đường chờ sau lời cuối; "
          f"model API chiếm **{summary['model_api_ms']['mean']/summary['total_ms']['mean']*100:.1f}%**. Đây là phép chia trên tổng/mean thời gian của các lượt hoàn tất, không cộng trung vị.",
          f"- Có trung vị **{summary['processing_sql_queries']['median']:.0f} SQL/lượt** sau khi chốt transcript. Trong các lượt bình thường, 85 query nằm ở 5 lần reconcile ngoài engine, còn khoảng 35 query ở trong engine.",
          '- `TurnService.execute/check` gọi `SessionService.reconcile`; bridge dùng `context()` để đọc cả memory context. Mỗi snapshot gồm nhiều query và transaction. Database ở xa qua SSH làm chi phí roundtrip lặp lại cộng dồn.',
          '- Engine dùng classify → reply → check với model đã cấu hình; moderation_input chạy cùng classify và moderation_output chạy cùng check. Một dispatch engine không đồng nghĩa một request LLM.',
          '- Trường timings của API có thể gộp cả reconcile DB vào stt/reply/tts. Bảng này đo adapter và transaction riêng để tránh quy toàn bộ số đó cho provider.',
          f"- Khởi tạo profile/config trước lượt có trung vị **{summary['profile_setup_ms']['median']/1000:.2f}s**; kết nối stream **{summary['stream_connect_ms']['median']/1000:.2f}s**. Hai khoản này không nằm trong tổng sau lời cuối.", '',
          '## Thứ tự tối ưu đề xuất', '',
          '1. Dùng kiểm tra version/state nhẹ ở các fence của TurnService thay cho tải lại toàn context; giữ kiểm tra stale state, hủy và forgetting, không bỏ các fence an toàn.',
          '2. Gom query snapshot hoặc giảm số roundtrip, đo lại cùng điều kiện. Đừng chỉ đổi Promise.all: adapter PostgreSQL hiện serialize query trên cùng transaction/connection.',
          '3. Sau đó mới đánh giá chi phí ba bước model bằng test chất lượng thật. Không tự thay model hoặc bỏ kiểm duyệt chỉ để đạt số latency tốt hơn.',
          '4. Giữ mốc VAD 3 giây đã chọn trong lần đo này. TTS đang nhỏ hơn nhiều so với DB và engine; ưu tiên tối ưu sau.', '',
          '## Từng API model', '', '| Bước | Số request | Trung vị (giây) | Tối đa (giây) |','| --- | ---: | ---: | ---: |']
for stage,values in stage_summary.items():lines.append(f"| {stage} | {values['requests']} | {values['median_ms']/1000:.2f} | {values['max_ms']/1000:.2f} |")
lines += ['', 'Các bước moderation có thể chạy song song với classify/check. Không cộng tất cả request duration rồi coi đó là latency của engine.', '',
          '## Từng file', '', '| File | VAD | Drain | DB | Model | TTS | Còn lại | Tổng (giây) | SQL sau chốt |',
          '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
for row in successful:
    values=[row[k]/1000 for k in list(labels)]
    lines.append('| '+row['id']+' | '+' | '.join(f'{v:.2f}' for v in values)+f" | {row['processing_sql_queries']} |")
lines += ['', '## Các lượt không có MP3', '', '| File | Trạng thái | Mã lỗi quan sát | Engine dispatch |', '| --- | --- | --- | ---: |']
for row in report['assets']:
    if row['status']!='completed':
        lines.append(f"| {row['id']} | {row['status']} | {row.get('error_code','')} | {row['engine_dispatches']} |")
if len(sys.argv)>2:
    followup_path=Path(sys.argv[2]).resolve()
    followup=json.loads(followup_path.read_text(encoding='utf-8'))
    diagnostic=followup['assets'][0]
    relative=Path(__import__('os').path.relpath(followup_path,report_path.parent)).as_posix()
    lines += ['', f"Đo lại riêng `{diagnostic['id']}` bằng schema mới: trạng thái **{diagnostic['status']}**, "
              f"mã lỗi engine thật **`{diagnostic.get('engine_error_code','unknown')}`**; "
              f"schema follow-up đã xóa: **{followup['schema_removed']}**. "
              'Không thay kết quả lần đầu bằng kết quả follow-up và không tính mẫu lỗi vào thống kê MP3 thành công. '
              f'[Dữ liệu chẩn đoán]({relative}).', '',
              'Trong lần này STT đã nhận đủ hai mệnh đề, nhưng engine chặn câu trả lời trước TTS. '
              'Transport WebSocket hiện che AppError thành `speech_stream_failed`, nên phải instrument bridge để thấy code gốc.']
audit_path=report_path.with_name('partial-db-audit.json')
if audit_path.exists():
    audit=json.loads(audit_path.read_text(encoding='utf-8'))
    lines += ['', '## Kiểm tra query theo partial', '',
              f"Trace {audit['before_change']['files']} file có **{audit['before_change']['partial_events']} partial**, "
              '**0 query và 0 transaction trong giai đoạn stream/drain**. Các query lớn được ghi nhận sau full transcript, không theo từng partial.', '',
              'Đã hoãn thêm một lần đọc context ở startup stream đến bước full transcript. Probe thật sau sửa xác nhận '
              '**0 query/transaction từ mở WebSocket đến acknowledgement cuối**, rồi engine/TTS hoàn tất. '
              'Kiểm tra state vẫn chạy trước engine; tạo phiên/config và maintenance riêng không thuộc callback partial. '
              '[Trace kiểm tra](partial-db-audit.json).', '',
              'Đây là thay đổi sau lượt benchmark chính. Nó giảm công việc lúc mở stream, không loại bỏ khoảng 120 query sau full trong các số đo phía trên.']
ping_path=report_path.with_name('db-roundtrip.json')
if ping_path.exists():
    ping=json.loads(ping_path.read_text(encoding='utf-8'))
    lines += ['', '## Kiểm tra roundtrip database', '',
              f"20 lần `SELECT 1` trên cùng kết nối đã warm có trung vị **{ping['median_ms']:.1f} ms**, "
              f"min–max **{ping['min_ms']:.1f}–{ping['max_ms']:.1f} ms**. "
              f"`EXPLAIN ANALYZE SELECT 1` báo server execution **{ping['server_execution_ms']:.3f} ms**.", '',
              'Đây là bằng chứng cho chi phí đường truyền/SSH/protocol trên từng roundtrip, không phải đo execution plan của mọi query thật. '
              '120 query nối tiếp cùng các BEGIN/COMMIT khiến chi phí này cộng dồn. [Dữ liệu ping](db-roundtrip.json).']
lines += ['', '## Vị trí code liên quan', '',
          '- [TurnService](../../backend/pipeline/src/modules/turns/turn.service.ts): reconcile trước begin và trong các check sau mỗi bước.',
          '- [SessionService](../../backend/pipeline/src/modules/sessions/session.service.ts): reconcile gọi bridge.context.',
          '- [Engine bridge](../../backend/integration/engine-bridge.ts): context lấy cả MemoryContext.',
          '- [Memory snapshot](../../backend/memory/index.ts): purge/clock và nhiều truy vấn bảng.',
          '- [PostgreSQL adapter](../../backend/memory/database.ts): query trên một transaction được serialize.', '',
          '## Chạy lại', '', 'Các lệnh từ root, provider thật có tính phí:', '', '```powershell',
          'node --env-file=.env --import tsx scripts/measure-voice-latency.ts --real',
          '# Có thể chọn --ids=01_vi_clean,09_vi_pause_2200ms,11_en_clean,19_en_pause_2200ms',
          'python scripts/summarize-voice-latency.py reports/<thu-muc-run>/report.json', '```', '',
          '## Giới hạn cách đo', '',
          '- Lời cuối lấy từ ranh giới clip nguồn TTS trong manifest, không phải alignment từng từ do người nghe xác nhận.',
          '- PCM được gửi theo thời gian thực, đợi đủ 200 ms trước mỗi chunk. Đuôi được bổ sung bằng chính nền cuối file để đủ thời gian chờ VAD.',
          '- Kết thúc phép đo ở lúc nhận MP3 đầy đủ. Chưa tính thời gian browser decode/autoplay hoặc microphone iPad vật lý.',
          '- Khởi tạo profile/session và kết nối STT được đo riêng; không gộp vào độ trễ sau lời cuối.',
          '- Profile test mới trong schema riêng; không có memory/history của người dùng thật. Dữ liệu là lượt thực đơn trên các ca tổng hợp khác nhau; không dùng để tuyên bố p95/SLA hay dự đoán production cùng máy với database.',
          '- Bản calibration chỉ bắt query ngoài transaction được giữ riêng và không dùng để kết luận phần database.', '',
          'Dữ liệu gốc: [report.json](report.json). Tổng hợp máy đọc: [summary.json](summary.json).', '']
report_path.with_name('report.md').write_text('\n'.join(lines),encoding='utf-8')

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig,ax=plt.subplots(figsize=(13,max(6,len(successful)*.38+2)))
    left=[0.0]*len(successful)
    chart_keys=list(labels)[:-1]
    english=['VAD wait','Final STT drain','DB / transactions','Model APIs','TTS','Other']
    colors=['#b7bdc6','#a7c8ee','#e09b3d','#675dcc','#3caa95','#e4a1ac']
    for key,label,color in zip(chart_keys,english,colors):
        values=[r[key]/1000 for r in successful]
        ax.barh([r['id'] for r in successful],values,left=left,label=label,color=color)
        left=[a+b for a,b in zip(left,values)]
    ax.invert_yaxis();ax.set_xlabel('Seconds after reference speech end until MP3 receipt')
    ax.set_title('Realtime voice latency — local app + remote PostgreSQL over SSH')
    ax.legend(loc='upper center',bbox_to_anchor=(.5,-.1),ncol=3,frameon=False)
    ax.spines[['top','right']].set_visible(False);ax.set_axisbelow(True);ax.grid(axis='x',alpha=.2)
    fig.tight_layout();fig.savefig(report_path.with_name('latency.png'),dpi=160,bbox_inches='tight');plt.close(fig)
except ImportError:
    pass
print(json.dumps({'completed':len(successful),'median_ms':{key:summary[key]['median'] for key in labels},'report':str(report_path.with_name('report.md'))},ensure_ascii=True))

# Deploy frontend và API Miu

Frontend React/Vite và backend character/memory/voice phục vụ cùng origin **https://miu.curiopal.com**. Deploy thủ công; không dùng webhook hoặc auto-deploy. Deployment này yêu cầu provider **real**, PostgreSQL và cấu hình speech logging rõ ràng trong `/etc/miu/api.env`.

## Các URL

**Bản realtime mới:** khi phát hành, cần cập nhật cả frontend/backend và location WebSocket trong `nginx-https.conf`, rồi `nginx -t` trước reload. Chọn `VOICE_INPUT_MODE=elevenlabs_realtime`, `STT_LOGGING=1`, `ELEVENLABS_VAD_SILENCE_MS=1000` trong env riêng Miu. Release realtime cần apply location WebSocket riêng của Miu trước nghiệm thu. Xem [realtime guide](../../docs/voice-pipeline/elevenlabs-realtime.md).

- Website: `https://miu.curiopal.com/`
- Hội thoại: `https://miu.curiopal.com/app/talk`
- API health: `https://miu.curiopal.com/api/health`
- SHA release: `https://miu.curiopal.com/deploy-info.json`
- 20 audio kiểm thử: `https://miu.curiopal.com/test-audio/`

Frontend dùng `VITE_DEMO_PUBLIC_URL=https://miu.curiopal.com` và để trống `VITE_VOICE_API_URL`, nên API cùng origin. Audio đi qua ElevenLabs STT → character/memory engine dùng OpenAI → ElevenLabs TTS. Tin nhắn nhập chữ dùng cùng engine và PostgreSQL. Chỉ receipt hoàn tất đọc hoặc phát mới commit learning; cancel hoặc lỗi TTS không tự học. Health/build không chứng minh chất lượng model hay microphone iPad thật.

## Phạm vi trên server

| Thành phần | Cấu hình |
| --- | --- |
| Release đang phục vụ | `/opt/miu/current` → `/opt/miu/releases/<commit>` |
| Frontend | Nginx root `/opt/miu/current/frontend/dist`, SPA fallback về `index.html` |
| API | `miu-api.service`, user `miu`, `127.0.0.1:4611` |
| Runtime | `/opt/node24/bin/node --import tsx /opt/miu/current/backend/integration/server.ts`, `/usr/bin/ffprobe`; Node hệ thống giữ nguyên |
| Database | PostgreSQL native `127.0.0.1:5432`, `DATABASE_SSH_TUNNEL=false`; không dùng PGlite trong release read-only |
| Git source | `/opt/miu/source`, public repo HTTPS read-only, không lưu GitHub write token |
| Build/cache | `/opt/miu/home-miu`, `/opt/miu/cache`, `/opt/miu/tmp` |
| Runtime env | `/etc/miu/api.env`, root `0600`, từ [api.env.example](api.env.example) |
| Deploy helper | `/usr/local/sbin/miu-deploy`, root-owned, từ [deploy.sh](deploy.sh) |
| Log/state | `/opt/miu/logs/deploy.log`, `/opt/miu/deploy-state.json` |
| Nginx | Chỉ vhost `miu.curiopal.com` và snippet prefix `miu-` |
| Certificate | `/etc/miu/letsencrypt`; work/log `/var/lib/miu/certbot`, `/var/log/miu-certbot` |
| Gia hạn TLS | `miu-cert-renew.timer`, hai lần/ngày, chỉ certificate Miu |

Không sửa checkout, process, service hoặc vhost của các project khác; không dùng `pm2 restart all`. `nginx -t` phải qua trước graceful reload. SSH/Cloudflare credentials giữ local, không chép nguyên `.env` lên server hoặc vào Git. Chỉ đặt provider keys/cấu hình runtime cần thiết trong `/etc/miu/api.env` root `0600`; không đưa key vào Git, public source/build, biến `VITE_*` hoặc môi trường build. Systemd đọc file này trước khi chạy user `miu`; service không cần quyền đọc trực tiếp file env.

`STT_LOGGING=1` chọn standard logging. Alias cũ `ELEVENLABS_ENABLE_LOGGING=true` vẫn được chấp nhận; nếu có cả hai thì giá trị phải tương đương. Tài khoản production này cần standard logging để tránh zero-retention enterprise gate; helper yêu cầu cấu hình bật rõ ràng. Không tự retry chuyển retention sau lỗi. Giữ `NODE_OPTIONS=--dns-result-order=ipv4first` vì đường IPv6 của server đã gây connect timeout. Theo lựa chọn model mới nhất, đặt `OPENAI_MODEL`, `OPENAI_CLASSIFY_MODEL`, `OPENAI_REPLY_MODEL` và `OPENAI_CHECK_MODEL` thành `gpt-5.6-luna`, với reasoning `none`. Moderation, embedding, STT và TTS tiếp tục dùng model riêng của từng endpoint. Helper không tự thay các giá trị model trong runtime env; cần cập nhật bốn key này trên server để ghi đè cấu hình cũ.

`TRUST_PROXY_LOOPBACK=true` chỉ tin proxy loopback. Nginx chỉ tin `CF-Connecting-IP` từ CIDR Cloudflare đã khai báo, sau đó **ghi đè** forwarded headers khi chuyển tới API. Tắt request/response buffering để không ghi audio/base64 vào Nginx temp files. Chỉ DNS record Miu được tạo/cập nhật, giữ nguyên SSL `strict` của zone.

## Deploy lại

Pull source về máy local để xem và kiểm thử:

```powershell
git pull --ff-only origin main
npm ci
npm run build
npm run typecheck
npm ci --prefix frontend
npm run build --prefix frontend
```

Sau khi code đã có trên GitHub, chạy qua SSH root:

```bash
/usr/local/sbin/miu-deploy
# Hoặc deploy chính xác một commit đã thuộc main:
/usr/local/sbin/miu-deploy --ref <40-character-commit-sha>
# Deploy branch riêng, không cần merge main:
/usr/local/sbin/miu-deploy --branch voice/elevenlabs-realtime-1s --ref <40-character-commit-sha>
```

Helper khóa riêng `/run/lock/miu-deploy.lock`, fetch repo cố định và chọn main mới nhất nếu không có `--ref`. Khi có `--ref`, helper kiểm tra ancestry trên branch được chọn rồi archive/build đúng SHA yêu cầu. Build/typecheck chạy bằng user `miu`, Node24 và nice/ionice. Môi trường build được xóa bằng `env -i`, đặt `MIU_PROVIDER=real`, không nhận runtime/provider secrets và không khởi tạo provider. Helper chỉ cài dependencies, build workspace, typecheck và build frontend; không chạy fake reply, fake HTTP smoke hoặc behavioral evaluation. Root và frontend có lockfile riêng; frontend phải có `dist/index.html` và `assets` trước activate.

Helper parse file runtime riêng tư trong process kiểm tra riêng, không `source` hoặc `eval` env. File phải là regular file root `0600`, không symlink. Preflight yêu cầu real provider, credentials có mặt, standard logging rõ ràng và PostgreSQL native; không ghi lại giá trị secret vào log. Health của release mới chỉ qua khi `status=ok`, `provider_mode=real`, `engine_mode=character_memory` và `capabilities.memory=true`. Health không gọi STT/GPT/TTS; nghiệm thu hành vi cần actual real-provider requests riêng, có provenance và lỗi thực tế.

Release được đóng dấu build/typecheck hoàn tất; marker không tuyên bố model quality. Trước cutover, helper backup rồi cài unit Miu và proxy snippet của đúng release, daemon-reload và kiểm tra `nginx -t` trước graceful reload. Proxy read timeout là150 giây. Các vhost, TLS và env không bị sửa. Sau đó đổi `current` atomic và restart riêng `miu-api.service`.

Nếu activation lỗi, helper khôi phục symlink, unit và proxy snippet trước rồi restart Miu. Health rollback chấp nhận legacy `voice_stub` nếu provider vẫn real; không yêu cầu release cũ có memory. Backup unit/snippet nằm trong `/opt/miu/ops/deploy-<sha>-...` root-only. Rollback không undo database migration hoặc thay đổi env; migration của release phải tương thích ngược. Giữ failed builds/releases để chẩn đoán, không tự prune. Cùng SHA đã có integrated health và đúng unit/snippet thì không restart.

[bootstrap.sh](bootstrap.sh) chỉ chuẩn bị user/thư mục, chưa tự cài mọi file. Lần cài đầu phải kiểm tra namespace chưa thuộc ứng dụng khác, copy helper/unit/proxy templates đúng vị trí, kiểm tra syntax và enable unit riêng. `.env.example` trong thư mục này là template không chứa secret.

## Vận hành

```bash
systemctl status miu-api --no-pager
journalctl -u miu-api -n 50 --no-pager
tail -n 100 /opt/miu/logs/deploy.log
cat /opt/miu/deploy-state.json
curl --fail http://127.0.0.1:4611/api/health
systemctl list-timers miu-cert-renew.timer
```

Certificate Miu dùng config/work/log và timer riêng để không tranh lock với Certbot của các app khác. [renew-certificate.sh](renew-certificate.sh) chỉ reload Nginx khi đúng lineage Miu. Không dùng `certbot --nginx` để tự sửa các vhost khác. Các CIDR trong [nginx-cloudflare-realip.conf](nginx-cloudflare-realip.conf) lấy từ danh sách công khai ngày 31/10/2026; cập nhật khi Cloudflare đổi ranges.

Unit/harness checks có thể dùng doubles được gắn nhãn rõ; chúng không chứng minh character/memory/model quality. Deployment này không chạy chúng. Fake runs cũ giữ nhãn `diagnostics_not_model_evaluation`; không tính vào kết luận real-provider. [Sites deployment riêng](../../frontend/README.md#separate-sites-deployment) và DNS `little-buddy.curiopal.com` được giữ nguyên.

Nguồn: [Nginx graceful reload](https://nginx.org/en/docs/control.html), [Cloudflare visitor IPs](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/).

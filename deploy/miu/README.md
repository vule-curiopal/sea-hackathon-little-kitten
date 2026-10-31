# Deploy frontend và API Miu

Frontend React/Vite và backend Express/TypeScript phục vụ cùng origin **https://miu.curiopal.com**. Deploy thủ công; không dùng webhook hoặc auto-deploy. Production voice ban đầu dùng **fake provider**, không gọi OpenAI/ElevenLabs.

## Các URL

- Website: `https://miu.curiopal.com/`
- Demo không cần đăng nhập: `https://miu.curiopal.com/demo/miu?lang=vi`
- API health: `https://miu.curiopal.com/api/health`
- SHA release: `https://miu.curiopal.com/deploy-info.json`
- 20 audio kiểm thử: `https://miu.curiopal.com/test-audio/`

Frontend dùng `VITE_DEMO_PUBLIC_URL=https://miu.curiopal.com` và để trống `VITE_VOICE_API_URL`, nên QR đúng domain và API cùng origin. Fake voice hiển thị đúng mode và dùng sample Buddy cố định; typing demo chạy local. Microphone iPad thật và chất lượng provider thật vẫn cần kiểm thử riêng.

## Phạm vi trên server

| Thành phần | Cấu hình |
| --- | --- |
| Release đang phục vụ | `/opt/miu/current` → `/opt/miu/releases/<commit>` |
| Frontend | Nginx root `/opt/miu/current/frontend/dist`, SPA fallback về `index.html` |
| API | `miu-api.service`, user `miu`, `127.0.0.1:4611` |
| Runtime | `/opt/node24/bin/node`, `/usr/bin/ffprobe`; Node hệ thống giữ nguyên |
| Git source | `/opt/miu/source`, public repo HTTPS read-only, không lưu GitHub write token |
| Build/cache | `/opt/miu/home-miu`, `/opt/miu/cache`, `/opt/miu/tmp` |
| Runtime env | `/etc/miu/api.env`, root `0600`, từ [api.env.example](api.env.example) |
| Deploy helper | `/usr/local/sbin/miu-deploy`, root-owned, từ [deploy.sh](deploy.sh) |
| Log/state | `/opt/miu/logs/deploy.log`, `/opt/miu/deploy-state.json` |
| Nginx | Chỉ vhost `miu.curiopal.com` và snippet prefix `miu-` |
| Certificate | `/etc/miu/letsencrypt`; work/log `/var/lib/miu/certbot`, `/var/log/miu-certbot` |
| Gia hạn TLS | `miu-cert-renew.timer`, hai lần/ngày, chỉ certificate Miu |

Không sửa checkout, process, service hoặc vhost của các project khác; không dùng `pm2 restart all`. `nginx -t` phải qua trước graceful reload. SSH/Cloudflare credentials giữ local, không chép nguyên `.env` lên server hoặc vào Git. Fake API không cần provider keys.

`TRUST_PROXY_LOOPBACK=true` chỉ tin proxy loopback. Nginx chỉ tin `CF-Connecting-IP` từ CIDR Cloudflare đã khai báo, sau đó **ghi đè** forwarded headers khi chuyển tới API. Tắt request/response buffering để không ghi audio/base64 vào Nginx temp files. Chỉ DNS record Miu được tạo/cập nhật, giữ nguyên SSL `strict` của zone.

## Deploy lại

Pull source về máy local để xem và kiểm thử:

```powershell
git pull --ff-only origin main
npm ci
npm run build
npm test
npm run smoke
npm ci --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend
```

Sau khi code đã có trên GitHub, chạy qua SSH root:

```bash
/usr/local/sbin/miu-deploy
# Hoặc giới hạn yêu cầu vào một commit đã thuộc main:
/usr/local/sbin/miu-deploy --ref <40-character-commit-sha>
```

Helper khóa riêng `/run/lock/miu-deploy.lock`, fetch repo cố định và chọn main mới nhất sau kiểm tra ancestry. Build/test chạy bằng user `miu`, Node24, nice/ionice và một Vitest worker. Root workspace và frontend có lockfile riêng: helper cài, test và build cả hai; frontend phải có `dist/index.html` và `assets` trước activate.

Release được đóng dấu hoàn tất và chuyển `current` bằng symlink atomic. Chỉ `miu-api.service` được restart; Nginx đọc static frontend qua cùng symlink. Khi health fail, helper khôi phục release trước và restart Miu. Giữ failed builds và releases để chẩn đoán; chưa tự prune. Cùng SHA đã healthy là no-op. Routine deploy không sửa Nginx/TLS.

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

115 Vitest tests/12 file và 24 frontend Node tests kiểm tra code; deployment health và mô phỏng browser chưa thay thế nghiệm thu iPad/API thật. [Sites deployment riêng](../../frontend/README.md#separate-sites-deployment) và DNS `little-buddy.curiopal.com` được giữ nguyên.

Nguồn: [Nginx graceful reload](https://nginx.org/en/docs/control.html), [Cloudflare visitor IPs](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/).

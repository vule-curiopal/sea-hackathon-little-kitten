#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run bootstrap as root.' >&2; exit 1; }
[[ -x /opt/node24/bin/node && -x /usr/bin/ffprobe ]] || { echo 'Required existing runtime is missing.' >&2; exit 1; }
[[ ! -L /opt/miu && ! -L /etc/miu ]] || { echo 'Miu roots must not be symlinks.' >&2; exit 1; }
if [[ -e /opt/miu && ! -f /opt/miu/.miu-owned ]]; then
  echo 'Existing /opt/miu is not managed by this deployment; refusing to overwrite.' >&2
  exit 1
fi
for account in miu; do
  if id "$account" >/dev/null 2>&1; then
    [[ $(getent passwd "$account" | cut -d: -f6) == "/opt/miu/home-$account" ]] || {
      echo "Account $account already belongs to another installation." >&2; exit 1;
    }
  else
    useradd --system --user-group --home-dir "/opt/miu/home-$account" --shell /usr/sbin/nologin "$account"
  fi
done
install -d -o root -g root -m 0755 /opt/miu /etc/miu
printf 'miu.curiopal.com deployment v1\n' > /opt/miu/.miu-owned
for directory in home-miu source cache tmp; do
  install -d -o miu -g miu -m 0750 "/opt/miu/$directory"
done
install -d -o root -g root -m 0755 /opt/miu/releases
install -d -o root -g root -m 0755 /var/lib/miu/acme
echo 'Miu-only directories and runtime account prepared.'

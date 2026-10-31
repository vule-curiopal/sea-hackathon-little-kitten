#!/bin/sh
set -eu
if [ "${RENEWED_LINEAGE:-}" = /etc/miu/letsencrypt/live/miu.curiopal.com ]; then
    /usr/sbin/nginx -t
    /usr/bin/systemctl reload nginx
fi

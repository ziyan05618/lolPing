#!/usr/bin/env bash
# Installs the lolPing room relay on the VPS over SSH. Idempotent: run it again to update the script.
#
#   VPS=root@47.107.156.194 KEY=~/.ssh/id_ed25519_lolping ./deploy.sh
#
# It never touches nginx, cloudflared, postgres or anything else already on the box: the relay is its own
# systemd unit on 127.0.0.1:8787, and the Cloudflare tunnel route is changed by hand in the dashboard.
set -euo pipefail

VPS="${VPS:-root@47.107.156.194}"
KEY="${KEY:-$HOME/.ssh/id_ed25519_lolping}"
PORT="${PORT:-8787}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "$VPS")
SCP=(scp -i "$KEY" -o StrictHostKeyChecking=accept-new)

echo "==> target $VPS, relay on 127.0.0.1:$PORT"

echo "==> creating the service account (no login shell, no home)"
"${SSH[@]}" "id -u lolping >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin lolping; mkdir -p /opt/lolping-relay"

echo "==> copying the relay"
"${SCP[@]}" "$HERE/lolping-relay.py" "$VPS:/opt/lolping-relay/lolping-relay.py"
"${SCP[@]}" "$HERE/lolping-relay.service" "$VPS:/etc/systemd/system/lolping-relay.service"

echo "==> writing the environment file (the capability path is generated once and kept)"
"${SSH[@]}" "set -e
  if [ ! -f /etc/lolping-relay.env ]; then
    printf 'RELAY_PORT=%s\nRELAY_PATH=%s\n' '$PORT' \"\$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')\" > /etc/lolping-relay.env
    chmod 600 /etc/lolping-relay.env
    echo '    generated a new RELAY_PATH'
  else
    sed -i 's/^RELAY_PORT=.*/RELAY_PORT=$PORT/' /etc/lolping-relay.env
    echo '    kept the existing RELAY_PATH'
  fi
  chown -R root:root /opt/lolping-relay
  chmod 755 /opt/lolping-relay && chmod 644 /opt/lolping-relay/lolping-relay.py
  systemctl daemon-reload
  systemctl enable lolping-relay >/dev/null 2>&1
  systemctl restart lolping-relay"

sleep 2
echo "==> status"
"${SSH[@]}" "systemctl is-active lolping-relay; systemctl --no-pager --lines=5 status lolping-relay | tail -6; ss -lntp | grep ':$PORT ' || echo 'WARNING: nothing listening on $PORT'"

echo
echo "==> capability path (append to wss://pet-api.zyyun618.com):"
"${SSH[@]}" "grep '^RELAY_PATH=' /etc/lolping-relay.env | cut -d= -f2"

echo
echo "The relay is up on 127.0.0.1:$PORT. Public access goes through nginx, not the Cloudflare tunnel:"
echo "  1. /etc/nginx/sites-enabled/pet-api.zyyun618.com  (see nginx-pet-api.conf)"
echo "  2. certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/.secrets/cf.ini \\"
echo "       --dns-cloudflare-propagation-seconds 30 -d pet-api.zyyun618.com --key-type ecdsa"
echo "  3. DNS: A record -> this server's IP, proxy off"
echo "Then verify:"
echo "  node tools/relay-probe/run.mjs --relays wss://pet-api.zyyun618.com/<path> --soak-min 0"

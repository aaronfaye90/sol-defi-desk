#!/usr/bin/env bash
# Run as root on a small Ubuntu 24.04 VPS after unpacking to /opt/sol-defi-desk.
# Usage: DESK_HOSTNAME=<ip>.sslip.io ACME_EMAIL=you@example.com bash /opt/sol-defi-desk/deploy/install_on_vps.sh
set -euo pipefail
: "${DESK_HOSTNAME:?Set DESK_HOSTNAME to e.g. 1.2.3.4.sslip.io}"
: "${ACME_EMAIL:?Set ACME_EMAIL (Lets Encrypt contact for Caddy)}"
# Strip accidental scheme if caller passed https://host
DESK_HOSTNAME="${DESK_HOSTNAME#https://}"
DESK_HOSTNAME="${DESK_HOSTNAME#http://}"
APP=/opt/sol-defi-desk
id survivor >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin survivor
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
# Node 20+ required by @solana/* (Ubuntu 24.04 apt node is 18)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs caddy
node -v
cd "$APP"
npm ci --omit=dev
mkdir -p "$APP/run"
if [[ ! -f "$APP/run/env" ]]; then
  sed "s|REPLACE_IP.sslip.io|${DESK_HOSTNAME}|g" "$APP/deploy/env.example" > "$APP/run/env"
fi
chown -R survivor:survivor "$APP"
install -m 644 "$APP/deploy/sol-defi-desk.service" /etc/systemd/system/sol-defi-desk.service
# Caddy treats hostnames that start with digits (e.g. 1.2.3.4.sslip.io) as IP
# addresses and skips HTTPS unless the site label is an https:// URL.
cat > /etc/caddy/Caddyfile <<CADDY
{
	email ${ACME_EMAIL}
}
https://${DESK_HOSTNAME} {
	reverse_proxy 127.0.0.1:4021
	encode gzip
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}
}
http://${DESK_HOSTNAME} {
	redir https://{host}{uri} permanent
}
CADDY
systemctl daemon-reload
systemctl enable --now sol-defi-desk
systemctl enable --now caddy
sleep 2
curl -fsS "http://127.0.0.1:4021/health"
echo
echo "Local health OK. Probe public:"
curl -fsS "https://${DESK_HOSTNAME}/health" || echo "(public HTTPS may need ~30s for LE; retry curl)"
echo "Next: one paid GET /v1/token-check (bazaar extension) to list on PayAI."

#!/usr/bin/env bash
set -euo pipefail

echo "==> DepthForge: Disabling Nginx HTTP Basic Auth (auth_basic)..."

NGINX_FILES=(
  "/etc/nginx/sites-available/depthforge.conf"
  "/etc/nginx/sites-enabled/depthforge.conf"
  "/etc/nginx/sites-enabled/default"
  "/etc/nginx/conf.d/depthforge.conf"
  "/etc/nginx/conf.d/default.conf"
)

FOUND=0
for conf in "${NGINX_FILES[@]}"; do
  if [ -f "$conf" ]; then
    if grep -E -q '^[[:space:]]*auth_basic' "$conf"; then
      echo "Found auth_basic directives in $conf - commenting them out..."
      sed -i -E 's/^([[:space:]]*)(auth_basic)/\1# \2/g' "$conf"
      FOUND=1
    fi
    # Ensure proxy_read_timeout and client_max_body_size are configured for photo-to-depth
    if ! grep -q 'proxy_read_timeout' "$conf"; then
      sed -i -E 's/(proxy_pass http:\/\/127.0.0.1:8001;)/\1\n        proxy_read_timeout 300s;\n        proxy_connect_timeout 300s;\n        client_max_body_size 50M;/g' "$conf" || true
      FOUND=1
    fi
  fi
done

# Also scan any other configuration files under /etc/nginx/sites-enabled/ and /etc/nginx/conf.d/
if [ -d /etc/nginx ]; then
  while IFS= read -r f; do
    if grep -E -q '^[[:space:]]*auth_basic' "$f"; then
      echo "Found auth_basic directives in $f - commenting them out..."
      sed -i -E 's/^([[:space:]]*)(auth_basic)/\1# \2/g' "$f"
      FOUND=1
    fi
  done < <(find /etc/nginx/sites-enabled /etc/nginx/sites-available /etc/nginx/conf.d -type f 2>/dev/null || true)
fi

if [ "$FOUND" -eq 1 ]; then
  echo "==> Testing Nginx configuration..."
  if command -v nginx >/dev/null 2>&1; then
    nginx -t
    echo "==> Reloading Nginx service..."
    if command -v systemctl >/dev/null 2>&1; then
      systemctl reload nginx || systemctl restart nginx
    elif command -v service >/dev/null 2>&1; then
      service nginx reload || service nginx restart
    else
      nginx -s reload
    fi
    echo "==> SUCCESS: Nginx Basic Auth has been removed and Nginx reloaded."
  else
    echo "==> Warning: nginx command not found in PATH."
  fi
else
  echo "==> No active auth_basic directives found in Nginx configs."
fi


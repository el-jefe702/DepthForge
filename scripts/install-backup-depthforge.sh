#!/usr/bin/env bash
set -euo pipefail

[ "${EUID}" -eq 0 ] || {
  echo "Run as root." >&2
  exit 1
}

command -v age >/dev/null || {
  echo "Install age first: apt update && apt install -y age rclone" >&2
  exit 1
}

command -v rclone >/dev/null || {
  echo "Install rclone first: apt update && apt install -y age rclone" >&2
  exit 1
}

KEY_FILE=/root/.config/depthforge-backup.agekey
CONFIG_FILE=/etc/depthforge-backup.env

mkdir -p /root/.config
chmod 700 /root/.config

if [ ! -f "$KEY_FILE" ]; then
  age-keygen -o "$KEY_FILE"
  chmod 600 "$KEY_FILE"
fi

RECIPIENT=$(
  grep -m1 '^# public key: ' "$KEY_FILE" \
    | sed 's/^# public key: //'
)

[ -n "$RECIPIENT" ] || {
  echo "Could not read age public recipient." >&2
  exit 1
}

cat > "$CONFIG_FILE" <<EOF
AGE_RECIPIENT=$RECIPIENT
RCLONE_REMOTE=gdrive
RCLONE_FOLDER=DepthForgeBackups
EOF

chmod 600 "$CONFIG_FILE"

install -m 700 scripts/backup-depthforge.sh \
  /usr/local/sbin/backup-depthforge

install -m 644 systemd/depthforge-backup.service \
  /etc/systemd/system/depthforge-backup.service

install -m 644 systemd/depthforge-backup.timer \
  /etc/systemd/system/depthforge-backup.timer

systemctl daemon-reload
systemctl enable --now depthforge-backup.timer

echo "Age recovery key: $KEY_FILE"
echo "Public recipient: $RECIPIENT"
echo "IMPORTANT: Save the recovery key outside the VPS and outside Google Drive."
echo "Next: configure rclone remote named gdrive, then run:"
echo "systemctl start depthforge-backup.service"

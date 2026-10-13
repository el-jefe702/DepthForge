#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE=/etc/depthforge-backup.env
[ -r "$CONFIG_FILE" ] || {
  echo "Missing $CONFIG_FILE. Run the installer first." >&2
  exit 1
}

source "$CONFIG_FILE"

: "${AGE_RECIPIENT:?AGE_RECIPIENT is required}"
: "${RCLONE_REMOTE:=gdrive}"
: "${RCLONE_FOLDER:=DepthForgeBackups}"

BACKUP_DIR=/root/backups/depthforge
LOCAL_KEEP=14
REMOTE_KEEP=30
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGING_DIR=$(mktemp -d)
ARCHIVE="$BACKUP_DIR/depthforge_$TIMESTAMP.tar.gz"
ENCRYPTED_ARCHIVE="$ARCHIVE.age"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR" "$STAGING_DIR/config" "$STAGING_DIR/volumes"

if [ -f /opt/depthforge/.env ]; then
  install -m 600 /opt/depthforge/.env \
    "$STAGING_DIR/config/depthforge.env"
fi

if [ -f /etc/nginx/sites-available/depthforge.conf ]; then
  install -m 600 /etc/nginx/sites-available/depthforge.conf \
    "$STAGING_DIR/config/depthforge.conf"
fi

if [ -d /etc/letsencrypt ]; then
  cp -a /etc/letsencrypt "$STAGING_DIR/config/letsencrypt"
fi

docker run --rm \
  -v depthforge_app_data:/source:ro \
  -v "$STAGING_DIR/volumes":/backup \
  alpine:3.20 sh -c 'cd /source && tar czf /backup/app_data.tar.gz .'

docker run --rm \
  -v depthforge_generated_data:/source:ro \
  -v "$STAGING_DIR/volumes":/backup \
  alpine:3.20 sh -c 'cd /source && tar czf /backup/generated_data.tar.gz .'

tar -C "$STAGING_DIR" -czf "$ARCHIVE" .

age -r "$AGE_RECIPIENT" -o "$ENCRYPTED_ARCHIVE" "$ARCHIVE"
rm -f "$ARCHIVE"
chmod 600 "$ENCRYPTED_ARCHIVE"

rclone mkdir "$RCLONE_REMOTE:$RCLONE_FOLDER"

rclone copyto \
  "$ENCRYPTED_ARCHIVE" \
  "$RCLONE_REMOTE:$RCLONE_FOLDER/$(basename "$ENCRYPTED_ARCHIVE")"

find "$BACKUP_DIR" \
  -maxdepth 1 \
  -type f \
  -name 'depthforge_*.tar.gz.age' \
  -printf '%T@ %p
' \
  | sort -nr \
  | awk -v keep="$LOCAL_KEEP" 'NR > keep {print $2}' \
  | xargs -r rm -f

rclone lsf "$RCLONE_REMOTE:$RCLONE_FOLDER" --files-only \
  | grep -E '^depthforge_[0-9]{8}T[0-9]{6}Z.tar.gz.age$' \
  | sort -r \
  | awk -v keep="$REMOTE_KEEP" 'NR > keep {print}' \
  | while IFS= read -r old_file; do
      [ -n "$old_file" ] && \
        rclone deletefile "$RCLONE_REMOTE:$RCLONE_FOLDER/$old_file"
    done

echo "Backup created and uploaded: $(basename "$ENCRYPTED_ARCHIVE")"
du -h "$ENCRYPTED_ARCHIVE" | cut -f1

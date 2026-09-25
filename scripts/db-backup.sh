#!/usr/bin/env bash
# Backup diario de la base de producción (Supabase). Corre dentro del servicio
# `db-backup` de docker-compose (imagen postgres:17) y escribe en /backups, que es
# un bind mount a la carpeta backups/ del proyecto en el host (BACKUP_HOST_DIR).
#
# Por qué existe: el 2026-09-24 la base de producción se vació por un comando de
# Prisma mal apuntado y el plan Free de Supabase no ofrece backups.
#
# SOLO LEE la base: pg_dump no escribe nada en el servidor.
#
# Modos:
#   bash db-backup.sh        → servicio: backup al arrancar si hoy no hay uno, y
#                              después todos los días a las BACKUP_HOUR_UTC.
#   bash db-backup.sh now    → un backup en el momento y termina.

set -uo pipefail

BACKUP_DIR=/backups
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
HOUR_UTC="${BACKUP_HOUR_UTC:-6}"      # 06:00 UTC = 03:00 en Argentina (UTC-3, sin horario de verano)
MAX_ATTEMPTS=3
RETRY_SECONDS=900

# Hora argentina sin depender de tzdata: Argentina es UTC-3 fijo.
art() { date -u -d '-3 hours' "$@"; }

log() {
  local line
  line="$(art '+%Y-%m-%d %H:%M:%S')  $*"
  echo "$line"
  echo "$line" >> "$BACKUP_DIR/backup.log"
}

backup_once() {
  if [ -z "${DIRECT_URL:-}" ]; then
    log "ERROR  DIRECT_URL no está definida"
    return 1
  fi
  # pg_dump no entiende los parámetros propios de Prisma (pgbouncer, connection_limit…)
  local url="${DIRECT_URL%%\?*}"
  local name tmp final size tables
  name="db_$(art +%Y-%m-%d_%H%M).dump"
  final="$BACKUP_DIR/$name"
  tmp="$final.partial"

  log "Iniciando backup -> $name"

  # Formato custom: comprimido y restaurable por tabla. Sólo el schema public (tablas
  # de la app + _prisma_migrations); los schemas internos de Supabase no se usan.
  if ! PGCONNECT_TIMEOUT=30 pg_dump "$url" --format=custom --schema=public \
        --no-owner --no-privileges --file="$tmp"; then
    log "ERROR  pg_dump falló"
    rm -f "$tmp"
    return 1
  fi

  # Validación: un archivo a medias o vacío no cuenta como backup.
  size=$(stat -c %s "$tmp")
  if [ "$size" -lt 10240 ]; then
    log "ERROR  el backup pesa $size bytes: demasiado chico"
    rm -f "$tmp"
    return 1
  fi
  tables=$(pg_restore --list "$tmp" 2>/dev/null | grep -c ' TABLE DATA ')
  if [ "$tables" -lt 10 ]; then
    log "ERROR  el backup trae datos de sólo $tables tablas: sospechoso"
    rm -f "$tmp"
    return 1
  fi

  mv "$tmp" "$final"
  log "OK  $name  $(awk "BEGIN { printf \"%.1f\", $size / 1048576 }") MB  $tables tablas con datos"

  # Retención: sólo archivos db_*.dump de esta carpeta.
  find "$BACKUP_DIR" -maxdepth 1 -name 'db_*.dump' -mtime +"$RETENTION_DAYS" -print -delete |
    while read -r old; do log "Retención: borrado $(basename "$old")"; done
  return 0
}

backup_with_retries() {
  local attempt
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    backup_once && return 0
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      log "Reintento $((attempt + 1))/$MAX_ATTEMPTS en $((RETRY_SECONDS / 60)) min"
      sleep "$RETRY_SECONDS"
    fi
  done
  log "ERROR  backup fallido tras $MAX_ATTEMPTS intentos"
  return 1
}

mkdir -p "$BACKUP_DIR"

if [ "${1:-}" = "now" ]; then
  backup_once
  exit $?
fi

log "Servicio de backup iniciado (diario a las ${HOUR_UTC}:00 UTC, retención ${RETENTION_DAYS} días)"

# Al arrancar (deploy, reinicio de la PC): si hoy todavía no hay backup, se hace ya.
if ! ls "$BACKUP_DIR"/db_"$(art +%Y-%m-%d)"_*.dump >/dev/null 2>&1; then
  backup_with_retries
fi

while true; do
  now=$(date -u +%s)
  next=$(date -u -d "today ${HOUR_UTC}:00" +%s)
  [ "$next" -le "$now" ] && next=$(date -u -d "tomorrow ${HOUR_UTC}:00" +%s)
  sleep $((next - now))
  backup_with_retries
done

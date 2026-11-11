# shellcheck shell=bash
# Limits on what a node's logs may take from its disk.
#
# Ubuntu ships none that matter on a small VPS: /var/log/syslog rotates
# weekly with no size limit and keeps the last week uncompressed, and the
# journal may grow to a tenth of the disk. On 2026-11-11 that was 14 of
# the 17 GB in use on one node and 6 of 8 on another, and 99% of the lines
# were three messages repeated every minute: strongSwan logging one line
# per stored secret each time the agent reloaded an unchanged credential
# list, the agent's own line per routine re-check, and OpenVPN noting each
# status poll. Agent v0.2.12 stops producing the first two. These limits
# are what holds when the next thing nobody expected starts to repeat.
#
# What this writes:
#   /etc/rsyslog.d/10-neoxify-quiet.conf        the three repeated messages stay out of
#                                               /var/log/syslog (they remain in the journal)
#   /etc/logrotate.d/neoxify-syslog             syslog daily, and sooner past 100 MB
#   /etc/systemd/system/logrotate.timer.d/      logrotate hourly, so a size limit is
#     neoxify-hourly.conf                       looked at through the day
#   /etc/systemd/journald.conf.d/50-neoxify.conf  journal capped at 500 MB
#
# rsyslog and journald are restarted; no VPN engine is touched and none
# depends on either (checked on the fleet: Xray, OpenVPN, strongSwan and
# WireGuard keep their process ids across both restarts).
#
# Every function here checks its own steps and returns non-zero rather
# than relying on `set -e`: the installer calls them as `f || warn`, and
# bash ignores `set -e` inside a function called that way.
#
# installer/maintenance/log-limits.sh runs the same functions on a node
# that is already live.

LOG_LIMITS_RULE=/etc/rsyslog.d/10-neoxify-quiet.conf
LOG_LIMITS_STANZA=/etc/logrotate.d/neoxify-syslog
LOG_LIMITS_TIMER=/etc/systemd/system/logrotate.timer.d/neoxify-hourly.conf
LOG_LIMITS_JOURNAL=/etc/systemd/journald.conf.d/50-neoxify.conf
LOG_LIMITS_PACKAGED=/etc/logrotate.d/rsyslog

# logrotate hourly instead of daily. Stanzas that say daily, weekly or
# monthly still rotate once per that period; only `maxsize` is looked at
# more often. Written on every node, rsyslog or not: the Xray stanza has
# a size limit too.
log_limits_timer() {
  command -v logrotate >/dev/null 2>&1 || { echo "log limits: logrotate is not installed, no timer written"; return 0; }
  [[ -e "$LOG_LIMITS_TIMER" ]] && return 0
  install -d -m 755 "$(dirname "$LOG_LIMITS_TIMER")" || return 1
  cat > "$LOG_LIMITS_TIMER" <<'EOF' || return 1
# Hourly instead of daily, so a `maxsize` in /etc/logrotate.d is checked
# through the day. See installer/lib/logs.sh.
[Timer]
OnCalendar=
OnCalendar=hourly
AccuracySec=1m
RandomizedDelaySec=5m
EOF
  chmod 644 "$LOG_LIMITS_TIMER" || return 1
  systemctl daemon-reload || return 1
  systemctl restart logrotate.timer || return 1
  echo "log limits: logrotate now runs hourly"
}

# Put back what log_limits_syslog changed, after a check failed.
log_limits_syslog_restore() {
  local backup="$1" why="$2"
  echo "log limits: $why -- putting the packaged syslog rotation back" >&2
  cp -a "$backup/rsyslog.logrotate" "$LOG_LIMITS_PACKAGED"
  rm -f "$LOG_LIMITS_RULE" "$LOG_LIMITS_STANZA"
  return 1
}

# The repeated messages out of /var/log/syslog, and syslog on a daily
# rotation with a size limit. Nothing is written until every check that
# can be made beforehand has passed, and a check that fails afterwards
# restores the packaged rotation before rsyslog is restarted.
log_limits_syslog() {
  command -v rsyslogd >/dev/null 2>&1 || { echo "log limits: no rsyslog on this server, the journal cap is its only limit"; return 0; }
  if [[ -e "$LOG_LIMITS_RULE" && -e "$LOG_LIMITS_STANZA" ]]; then
    echo "log limits: syslog rules already in place"
    return 0
  fi
  if [[ -e "$LOG_LIMITS_RULE" || -e "$LOG_LIMITS_STANZA" ]]; then
    echo "log limits: half applied ($LOG_LIMITS_RULE or $LOG_LIMITS_STANZA exists without the other); look by hand" >&2
    return 1
  fi
  [[ -f "$LOG_LIMITS_PACKAGED" ]] || { echo "log limits: $LOG_LIMITS_PACKAGED is missing, syslog rotation left alone" >&2; return 1; }
  grep -qx '/var/log/syslog' "$LOG_LIMITS_PACKAGED" || { echo "log limits: no stand-alone /var/log/syslog line in $LOG_LIMITS_PACKAGED, syslog rotation left alone" >&2; return 1; }
  [[ -x /usr/lib/rsyslog/rsyslog-rotate ]] || { echo "log limits: /usr/lib/rsyslog/rsyslog-rotate is missing, syslog rotation left alone" >&2; return 1; }

  local backup check
  backup="/root/pre-log-limits-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$backup" || return 1
  cp -a "$LOG_LIMITS_PACKAGED" "$backup/rsyslog.logrotate" || return 1

  cat > "$LOG_LIMITS_RULE" <<'EOF' || return 1
# Kept out of /var/log/syslog; all of it stays in the journal (journalctl).
# See installer/lib/logs.sh.
#
# strongSwan, one line per stored secret on every credential reload. Its
# program name is charon-systemd under strongswan.service, charon and
# ipsec under strongswan-starter.
if (($programname == "charon-systemd" or $programname == "charon" or $programname == "ipsec") and ($msg contains "loaded EAP shared key" or $msg contains "loaded certificate" or $msg contains "loaded RSA private key")) then stop
# The agent's line per routine re-check (agents older than v0.2.12). The
# one-time confirmation of a new credential is kept.
if ($programname == "agentd" and $msg contains "executed command reassert" and not ($msg contains "reassert-confirm")) then stop
# The agent's 10-second poll of the OpenVPN status, three lines each time.
if ($programname == "openvpn" and ($msg contains "MANAGEMENT: Client connected from" or $msg contains "MANAGEMENT: Client disconnected" or $msg contains "MANAGEMENT: CMD 'status 2'")) then stop
EOF
  chmod 644 "$LOG_LIMITS_RULE" || return 1
  check="$(rsyslogd -N1 2>&1)" || { echo "$check" >&2; rm -f "$LOG_LIMITS_RULE"; echo "log limits: rsyslog refused the rule file, removed" >&2; return 1; }
  if grep -qi 'error' <<<"$check"; then
    echo "$check" >&2; rm -f "$LOG_LIMITS_RULE"
    echo "log limits: rsyslog's config check printed an error, rule file removed" >&2
    return 1
  fi

  sed -i '\#^/var/log/syslog$#d' "$LOG_LIMITS_PACKAGED" || { log_limits_syslog_restore "$backup" "could not edit the packaged stanza"; return 1; }
  cat > "$LOG_LIMITS_STANZA" <<'EOF' || { log_limits_syslog_restore "$backup" "could not write the stanza"; return 1; }
# /var/log/syslog rotates daily, and sooner once it passes 100 MB
# (logrotate runs hourly). The packaged stanza rotated it weekly with no
# size limit; its line was taken out of /etc/logrotate.d/rsyslog, which
# still rotates the other logs. See installer/lib/logs.sh.
/var/log/syslog
{
	rotate 30
	daily
	maxsize 100M
	missingok
	notifempty
	compress
	delaycompress
	sharedscripts
	postrotate
		/usr/lib/rsyslog/rsyslog-rotate
	endscript
}
EOF
  chmod 644 "$LOG_LIMITS_STANZA"

  # A dry run of the whole configuration: no error, and syslog rotated by
  # exactly one stanza. Zero would mean it is no longer rotated at all.
  local dry errors seen duplicates
  dry="$(/usr/sbin/logrotate -d /etc/logrotate.conf 2>&1 || true)"
  errors="$(grep -ci '^error' <<<"$dry" || true)"
  seen="$(grep -c 'considering log /var/log/syslog$' <<<"$dry" || true)"
  duplicates="$(grep -ci 'duplicate log entry' <<<"$dry" || true)"
  if [[ "$errors" != 0 || "$seen" != 1 || "$duplicates" != 0 ]]; then
    grep -i '^error\|duplicate' <<<"$dry" | head -5 >&2
    log_limits_syslog_restore "$backup" "logrotate's dry run was not clean (errors $errors, syslog handled $seen time(s), duplicates $duplicates)"
    return 1
  fi

  systemctl restart rsyslog || { log_limits_syslog_restore "$backup" "rsyslog did not restart"; systemctl restart rsyslog; return 1; }
  sleep 1
  if [[ "$(systemctl is-active rsyslog)" != active ]]; then
    log_limits_syslog_restore "$backup" "rsyslog is not active after its restart"
    systemctl restart rsyslog
    return 1
  fi
  echo "log limits: repeated lines kept out of /var/log/syslog; syslog rotates daily or past 100 MB (backup $backup)"
}

# The journal capped at 500 MB. journald applies a new cap when it
# starts, and deletes its oldest entries down to it, so on a node that is
# already live this is the step that removes history.
log_limits_journal() {
  if [[ -e "$LOG_LIMITS_JOURNAL" ]]; then
    echo "log limits: journal cap already in place"
    return 0
  fi
  install -d -m 755 "$(dirname "$LOG_LIMITS_JOURNAL")" || return 1
  cat > "$LOG_LIMITS_JOURNAL" <<'EOF' || return 1
# The default lets the journal take a tenth of the disk (up to 4 GB).
# See installer/lib/logs.sh.
[Journal]
SystemMaxUse=500M
EOF
  chmod 644 "$LOG_LIMITS_JOURNAL" || return 1
  systemctl restart systemd-journald || { echo "log limits: journald did not restart" >&2; return 1; }
  echo "log limits: journal capped at 500 MB"
}

# All of it, for a new node. Never fatal: a node without these limits
# works, and an install that stopped here would not.
install_log_limits() {
  log_limits_timer || echo "WARNING: could not make logrotate hourly; size limits are checked once a day." >&2
  log_limits_syslog || echo "WARNING: /var/log/syslog keeps Ubuntu's weekly rotation with no size limit." >&2
  log_limits_journal || echo "WARNING: the journal keeps its default limit of a tenth of the disk." >&2
}

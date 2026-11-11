#!/usr/bin/env bash
# What a provider's image brings along that a node must not keep.
#
# The installer was written on images that arrive bare: no firewall, a
# hostname nobody chose, no swap. In November 2026 two nodes were built
# on an image that arrived otherwise, and every item below was found and
# repaired by hand, one of them only after a reboot put it back:
#
#   ufw       active, INPUT and FORWARD on DROP, a handful of ports open.
#             Every engine port would have been closed and nothing would
#             have been forwarded. Removing the package is not enough: its
#             chains stay loaded, and the next `netfilter-persistent save`
#             writes them into the rules the node boots with.
#   hostname  the label typed into the provider's dashboard, which carried
#             the brand. Renaming the box lasts until the next boot:
#             cloud-init sets the name again, and rewrites /etc/hosts, from
#             the provider's metadata. It has to be pinned in cloud.cfg.d.
#   swap      a swap file of the provider's own size. The fleet form is 2 GB
#             on a small box, with one known line in /etc/fstab.
#   fwupd     a firmware refresh timer that fails on a virtual machine and
#             leaves a failed unit behind on every run.
#   interface a name other than eth0. Nothing here may assume one.
#   ipv6      no global address at all, with IPv6 resolvers still listed.
#
# Each item is looked at first and repaired only when it is found, so all
# of this is safe to run on an image that has none of it, and to run
# twice. The same functions answer three callers: the installer on a
# fresh node (prepare_provider_image), every place the installer saves
# the firewall rules (drop_ufw_leftovers), and
# installer/maintenance/provider-image.sh, which is how to look at a box
# without changing it.
#
# What is NOT repaired, on purpose: a DROP policy that is not ufw's. That
# is somebody's own firewall, and it is reported and left alone.
set -euo pipefail

# A word in a hostname that says whose server this is, or what it is for.
IMAGE_BRAND_RE='neox|neoconnect|vpn|proxy'
IMAGE_HOSTNAME_PIN="${IMAGE_HOSTNAME_PIN:-/etc/cloud/cloud.cfg.d/99-neoxify-hostname.cfg}"
IMAGE_UFW_CONF="${IMAGE_UFW_CONF:-/etc/ufw/ufw.conf}"
IMAGE_SWAPFILE=/swapfile
IMAGE_SWAP_MB=2048
# A box with no more memory than this gets the swap file: 1 GB servers
# report a little under 1000 MB.
IMAGE_SMALL_BOX_MB=1100

image_backup_stamp() { date -u +%Y%m%dT%H%M%SZ; }

# ------------------------------------------------------------------ ufw

# Are any of ufw's chains loaded in that table set (iptables or
# ip6tables)? Read into a variable first: under pipefail, `-S | grep -q`
# fails when grep closes the pipe on its first match.
image_ipt_has_ufw() {
  local rules
  command -v "$1" >/dev/null 2>&1 || return 1
  rules="$("$1" -S 2>/dev/null || true)"
  grep -qE '^-N ufw6?-' <<<"$rules"
}

image_ufw_active() {
  local status
  command -v ufw >/dev/null 2>&1 || return 1
  status="$(ufw status 2>/dev/null || true)"
  if grep -q '^Status: active' <<<"$status"; then
    return 0
  fi
  grep -qsi '^ENABLED=yes' "$IMAGE_UFW_CONF"
}

# "INPUT DROP FORWARD DROP", or nothing when both accept.
image_closed_policies() {
  local rules
  rules="$(iptables -S 2>/dev/null || true)"
  sed -n -E 's/^-P (INPUT|FORWARD) (DROP|REJECT)$/\1 \2/p' <<<"$rules" | tr '\n' ' ' | sed 's/ $//'
}

# Each *_state function prints one line saying what it found, and returns
#   0  nothing to repair
#   1  found, and the matching *_fix repairs it
#   2  found, and it is a person's to look at: nothing here changes it
image_ufw_state() {
  local pol left=0 ipt
  pol="$(image_closed_policies)"
  if image_ufw_active; then
    echo "ufw: ACTIVE${pol:+ (policy $pol)}. It closes every engine port and stops forwarding"
    return 1
  fi
  for ipt in iptables ip6tables; do
    if image_ipt_has_ufw "$ipt"; then
      left=1
    fi
  done
  if [[ "$left" == 1 ]]; then
    echo "ufw: not running, but its chains are still loaded${pol:+ (policy $pol)}. They would be saved with the firewall rules"
    return 1
  fi
  if [[ -n "$pol" ]]; then
    echo "firewall: policy $pol, and it is not ufw's. Left as it is: whoever set it has to open the engines' ports"
    return 2
  fi
  echo "ufw: not active, none of its chains loaded"
}

# Takes ufw's chains out of the running tables, and nothing else.
#
# The order is the safety. The policies go back to ACCEPT FIRST: a ufw
# that was removed while it was active leaves INPUT on DROP with the rule
# that lets SSH in inside one of its own chains, and deleting that chain
# under a DROP policy locks the box. Then the jumps out of the built-in
# chains, then every ufw chain emptied (they jump to one another, and a
# chain that is still referenced cannot be deleted), then deleted.
image_drop_ufw_chains() {
  local ipt chain rule rules
  for ipt in iptables ip6tables; do
    image_ipt_has_ufw "$ipt" || continue
    for chain in INPUT FORWARD OUTPUT; do
      "$ipt" -P "$chain" ACCEPT 2>/dev/null || true
    done
    rules="$("$ipt" -S 2>/dev/null || true)"
    while read -r rule; do
      [[ -n "$rule" ]] || continue
      # shellcheck disable=SC2086
      "$ipt" ${rule/-A /-D } 2>/dev/null || true
    done < <(grep -E '^-A (INPUT|FORWARD|OUTPUT) .*-j ufw6?-' <<<"$rules" || true)
    while read -r chain; do
      [[ -n "$chain" ]] || continue
      "$ipt" -F "$chain" 2>/dev/null || true
    done < <(sed -n -E 's/^-N (ufw6?-[^ ]+)$/\1/p' <<<"$rules")
    while read -r chain; do
      [[ -n "$chain" ]] || continue
      "$ipt" -X "$chain" 2>/dev/null || true
    done < <(sed -n -E 's/^-N (ufw6?-[^ ]+)$/\1/p' <<<"$rules")
  done
}

# Disabled through ufw itself (which puts the policies back to ACCEPT and
# cannot lock anyone out), then removed, then its chains taken out. The
# fleet runs without ufw: the engines' ports are chosen per node, and
# iptables-persistent, which the installer needs, conflicts with the
# package and removes it anyway -- leaving the chains behind.
image_ufw_fix() {
  local ts installed
  ts="$(image_backup_stamp)"
  if image_ufw_active; then
    ufw status verbose >"/root/ufw-status-before-neoxify-$ts.txt" 2>&1 || true
    tar -czf "/root/ufw-config-before-neoxify-$ts.tgz" -C / etc/ufw 2>/dev/null || true
    ufw --force disable >/dev/null 2>&1 || true
    echo "  ufw was active: disabled. What it allowed is in /root/ufw-status-before-neoxify-$ts.txt,"
    echo "  its configuration in /root/ufw-config-before-neoxify-$ts.tgz."
  fi
  installed="$(dpkg-query -W -f='${Status}' ufw 2>/dev/null || true)"
  if [[ "$installed" == "install ok installed" ]]; then
    systemctl disable --now ufw >/dev/null 2>&1 || true
    if DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq ufw >/dev/null 2>&1; then
      echo "  ufw removed. To take that back: apt-get install ufw, allow every engine port, then ufw enable."
    else
      echo "  WARNING: the ufw package could not be removed. It is disabled." >&2
    fi
  fi
  image_drop_ufw_chains
}

# Called before every `netfilter-persistent save` in the installer.
#
# Whatever is loaded at that moment becomes what the node boots with, so
# chains ufw left behind must be gone first. A ufw that is ACTIVE at that
# point is somebody's decision on a node that already exists (a fresh
# install has disabled it by then), and tearing it down as a side effect
# of "reconfigure an engine" is not this function's to do: it says so and
# leaves it.
drop_ufw_leftovers() {
  local ipt found=0
  for ipt in iptables ip6tables; do
    if image_ipt_has_ufw "$ipt"; then
      found=1
    fi
  done
  [[ "$found" == 1 ]] || return 0
  if image_ufw_active; then
    echo "  WARNING: ufw is active on this node, so its chains and policies are being saved with the" >&2
    echo "           firewall rules. A node does not run ufw: see docs/installer-os-support.md." >&2
    return 0
  fi
  image_drop_ufw_chains
  echo "  ufw's leftover chains removed before the firewall rules are saved."
}

# ------------------------------------------------------------- hostname

image_has_brand() { grep -qiE "$IMAGE_BRAND_RE" <<<"$1"; }

image_hostname_pinned() {
  [[ -f "$IMAGE_HOSTNAME_PIN" ]] || return 1
  grep -q '^preserve_hostname: true' "$IMAGE_HOSTNAME_PIN" && grep -q '^hostname: ' "$IMAGE_HOSTNAME_PIN"
}

# The name cloud-init would give the box at its next boot, when there is
# a cloud-init to ask. This is the provider's metadata, so it still shows
# the dashboard label after the box has been renamed by hand. Asked under
# both names the key has had; a cloud-init that answers to neither gives
# nothing, and the box's own names are then all that is looked at.
image_cloud_hostname() {
  command -v cloud-init >/dev/null 2>&1 || return 0
  cloud-init query v1.local_hostname 2>/dev/null || cloud-init query local_hostname 2>/dev/null || true
}

image_hostname_state() {
  local where="" cloud
  if image_has_brand "$(hostname 2>/dev/null || true)"; then
    where+=", the hostname"
  fi
  if [[ -r /etc/hostname ]] && image_has_brand "$(cat /etc/hostname)"; then
    where+=", /etc/hostname"
  fi
  if grep -qsiE "$IMAGE_BRAND_RE" /etc/hosts; then
    where+=", /etc/hosts"
  fi
  if ! image_hostname_pinned; then
    cloud="$(image_cloud_hostname)"
    if [[ -n "$cloud" ]] && image_has_brand "$cloud"; then
      where+=", cloud-init's metadata (it names the box again at every boot)"
    fi
  fi
  if [[ -n "$where" ]]; then
    echo "hostname: a brand word in ${where#, }"
    return 1
  fi
  if image_hostname_pinned; then
    echo "hostname: generic, and pinned against cloud-init"
  else
    echo "hostname: generic"
  fi
}

# The name a renamed box gets: the distribution's own id, which is what a
# stock image is called before anybody names it.
image_generic_hostname() {
  local id
  # shellcheck disable=SC1091
  id="$( (. /etc/os-release 2>/dev/null && echo "${ID:-}") || true)"
  [[ "$id" =~ ^[a-z0-9]+$ ]] || id="server"
  echo "$id"
}

# image_hosts_generic <hosts file> <new name>: the file, with every name
# that carries a brand word replaced, and no name twice on a line.
image_hosts_generic() {
  awk -v re="$IMAGE_BRAND_RE" -v new="$2" '
    /^[[:space:]]*#/ || NF < 2 { print; next }
    {
      changed = 0
      for (i = 2; i <= NF; i++) if (tolower($i) ~ re) { $i = new; changed = 1 }
      if (!changed) { print; next }
      line = $1
      seen = " "
      for (i = 2; i <= NF; i++) {
        if (index(seen, " " $i " ") == 0) { line = line " " $i; seen = seen $i " " }
      }
      print line
    }' "$1"
}

# The pin is written FIRST, and with the name in it. `preserve_hostname`
# alone was tried on the first build and was not enough: the provider's
# vendor data forces manage_etc_hosts on, and at the next boot cloud-init
# rendered /etc/hosts from its metadata again, label and all. With
# hostname and fqdn set here it renders the generic name instead.
image_hostname_fix() {
  local new now ts tmp
  ts="$(image_backup_stamp)"
  now="$(hostname 2>/dev/null || true)"
  if [[ -n "$now" ]] && ! image_has_brand "$now" && [[ "$now" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
    new="$now"
  else
    new="$(image_generic_hostname)"
  fi
  cp -a /etc/hosts "/root/hosts.before-neoxify-$ts" 2>/dev/null || true
  printf '%s\n' "$now" >"/root/hostname.before-neoxify-$ts" 2>/dev/null || true

  if [[ -d "$(dirname "$IMAGE_HOSTNAME_PIN")" ]]; then
    cat >"$IMAGE_HOSTNAME_PIN" <<EOF
# Written by the node installer (installer/lib/image.sh).
# The provider's image names this server after the label typed into its
# dashboard, again at every boot. These lines keep the name set here.
preserve_hostname: true
manage_etc_hosts: false
hostname: $new
fqdn: $new
prefer_fqdn_over_hostname: false
EOF
    chmod 644 "$IMAGE_HOSTNAME_PIN"
  fi

  if [[ "$new" != "$now" ]]; then
    if ! hostnamectl set-hostname "$new" 2>/dev/null; then
      echo "$new" >/etc/hostname
      hostname "$new" 2>/dev/null || true
    fi
  elif [[ -r /etc/hostname ]] && image_has_brand "$(cat /etc/hostname)"; then
    echo "$new" >/etc/hostname
  fi

  # Let cloud-init render /etc/hosts once now, with the pin in place, so
  # what it writes at the next boot is what is checked today.
  if command -v cloud-init >/dev/null 2>&1 && [[ -f "$IMAGE_HOSTNAME_PIN" ]]; then
    cloud-init single --name update_etc_hosts >/dev/null 2>&1 || true
  fi
  if grep -qsiE "$IMAGE_BRAND_RE" /etc/hosts; then
    tmp="$(mktemp)"
    if image_hosts_generic /etc/hosts "$new" >"$tmp"; then
      cat "$tmp" >/etc/hosts
    fi
    rm -f "$tmp"
  fi
  if ! grep -qsE "[[:space:]]${new}([[:space:]]|\$)" /etc/hosts; then
    echo "127.0.1.1 $new" >>/etc/hosts
  fi
  echo "  hostname is now '$new', pinned in $IMAGE_HOSTNAME_PIN (the old name and /etc/hosts are kept in"
  echo "  /root/hostname.before-neoxify-$ts and /root/hosts.before-neoxify-$ts). Whether it holds is only"
  echo "  known after a reboot."
}

# ----------------------------------------------------------------- swap

image_mem_mb() { awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null; }

image_swap_on() { awk -v f="$1" 'NR > 1 && $1 == f {found = 1} END {exit !found}' /proc/swaps 2>/dev/null; }

image_swap_state() {
  local mem other size want
  want=$((IMAGE_SWAP_MB * 1024 * 1024))
  mem="$(image_mem_mb)"
  if [[ "${mem:-0}" -gt "$IMAGE_SMALL_BOX_MB" ]]; then
    echo "swap: ${mem} MB of memory, not a small box. Left as the image has it"
    return 0
  fi
  other="$(awk -v f="$IMAGE_SWAPFILE" 'NR > 1 && $1 != f {printf "%s ", $1}' /proc/swaps 2>/dev/null || true)"
  if [[ -n "$other" ]]; then
    echo "swap: on ${other% }, which is not $IMAGE_SWAPFILE. Left as the image has it"
    return 0
  fi
  if ! image_swap_on "$IMAGE_SWAPFILE"; then
    echo "swap: a small box (${mem:-?} MB) with no swap. The fleet form is a ${IMAGE_SWAP_MB} MB $IMAGE_SWAPFILE"
    return 1
  fi
  size="$(stat -c %s "$IMAGE_SWAPFILE" 2>/dev/null || echo 0)"
  if [[ "$size" != "$want" ]]; then
    echo "swap: the image's $IMAGE_SWAPFILE is $((size / 1048576)) MB. The fleet form is ${IMAGE_SWAP_MB} MB"
    return 1
  fi
  if ! grep -qsE "^${IMAGE_SWAPFILE}[[:space:]]+none[[:space:]]+swap[[:space:]]+sw[[:space:]]+0[[:space:]]+0[[:space:]]*\$" /etc/fstab; then
    echo "swap: $IMAGE_SWAPFILE is ${IMAGE_SWAP_MB} MB, but /etc/fstab does not hold the fleet's line for it"
    return 1
  fi
  echo "swap: ${IMAGE_SWAP_MB} MB $IMAGE_SWAPFILE, in /etc/fstab"
}

# image_fstab_fleet <fstab file>: the file with exactly one line for the
# swap file, the fleet's.
image_fstab_fleet() {
  awk -v f="$IMAGE_SWAPFILE" '$1 != f {print}' "$1"
  echo "$IMAGE_SWAPFILE none swap sw 0 0"
}

# Only ever called on a small box whose swap is the swap file or nothing
# (image_swap_state returned 1). A swap file that holds more than fits
# back into memory is left alone: this runs on a box nobody is on yet,
# where nothing is in swap, and anywhere else it is not worth an OOM.
image_swap_fix() {
  local ts size want used avail tmp
  want=$((IMAGE_SWAP_MB * 1024 * 1024))
  ts="$(image_backup_stamp)"
  size="$(stat -c %s "$IMAGE_SWAPFILE" 2>/dev/null || echo 0)"
  cp -a /etc/fstab "/root/fstab.before-neoxify-$ts" 2>/dev/null || true
  if [[ "$size" != "$want" ]]; then
    if image_swap_on "$IMAGE_SWAPFILE"; then
      used="$(awk -v f="$IMAGE_SWAPFILE" 'NR > 1 && $1 == f {print $4}' /proc/swaps)"
      avail="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
      if [[ "${used:-0}" -ge "${avail:-0}" ]]; then
        echo "  WARNING: ${used} kB of the image's swap file is in use and does not fit back into memory. Left as it is." >&2
        return 0
      fi
      if ! swapoff "$IMAGE_SWAPFILE" 2>/dev/null; then
        echo "  WARNING: could not turn the image's swap file off. Left as it is." >&2
        return 0
      fi
    fi
    rm -f "$IMAGE_SWAPFILE"
    if ! fallocate -l "${IMAGE_SWAP_MB}M" "$IMAGE_SWAPFILE" 2>/dev/null &&
      ! dd if=/dev/zero of="$IMAGE_SWAPFILE" bs=1M count="$IMAGE_SWAP_MB" status=none 2>/dev/null; then
      echo "  WARNING: could not create a ${IMAGE_SWAP_MB} MB $IMAGE_SWAPFILE. This box has NO swap now." >&2
      rm -f "$IMAGE_SWAPFILE"
      return 0
    fi
    chmod 600 "$IMAGE_SWAPFILE"
    if ! mkswap "$IMAGE_SWAPFILE" >/dev/null 2>&1; then
      echo "  WARNING: mkswap failed on $IMAGE_SWAPFILE. This box has NO swap now." >&2
      return 0
    fi
  fi
  if ! image_swap_on "$IMAGE_SWAPFILE" && ! swapon "$IMAGE_SWAPFILE" 2>/dev/null; then
    echo "  WARNING: could not turn $IMAGE_SWAPFILE on. This box has NO swap now." >&2
    return 0
  fi
  tmp="$(mktemp)"
  if image_fstab_fleet /etc/fstab >"$tmp"; then
    cat "$tmp" >/etc/fstab
  fi
  rm -f "$tmp"
  echo "  swap is a ${IMAGE_SWAP_MB} MB $IMAGE_SWAPFILE with the fleet's line in /etc/fstab (the old file: /root/fstab.before-neoxify-$ts)."
}

# ---------------------------------------------------------------- fwupd

image_fwupd_state() {
  local state
  if ! systemctl cat fwupd-refresh.timer >/dev/null 2>&1; then
    echo "fwupd: no firmware refresh timer on this image"
    return 0
  fi
  if ! systemd-detect-virt --vm --quiet 2>/dev/null; then
    echo "fwupd: a firmware refresh timer, on real hardware. Left on"
    return 0
  fi
  state="$(systemctl is-enabled fwupd-refresh.timer 2>/dev/null || true)"
  if [[ "$state" == masked* ]]; then
    echo "fwupd: firmware refresh timer masked"
    return 0
  fi
  echo "fwupd: fwupd-refresh.timer is ${state:-there} on a virtual machine, where the refresh fails and leaves a failed unit"
  return 1
}

image_fwupd_fix() {
  systemctl mask --now fwupd-refresh.timer >/dev/null 2>&1 || true
  systemctl reset-failed fwupd-refresh.service >/dev/null 2>&1 || true
  echo "  fwupd-refresh.timer masked (a virtual machine has no firmware to refresh). To take that back:"
  echo "  systemctl unmask fwupd-refresh.timer && systemctl enable --now fwupd-refresh.timer"
}

# ------------------------------------------------- interface and IPv6

# Reported, never repaired: there is nothing to repair. Every rule the
# installer writes names the interface the routing table gives it
# (detect_default_iface in agent.sh), and scripts/fleet's tests fail if a
# fixed interface name is ever written into either tree.
image_iface_state() {
  local iface
  iface="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") print $(i + 1)}' | head -n1 || true)"
  if [[ -z "$iface" ]]; then
    echo "interface: NO default IPv4 route. Nothing can be NATed out of this box"
    return 2
  fi
  echo "interface: $iface carries the default route (rules are written for that name, whatever it is)"
}

image_ipv6_state() {
  local n r6 note=""
  n="$(ip -6 addr show scope global 2>/dev/null | grep -c inet6 || true)"
  r6="$(grep -cE '^nameserver[[:space:]]+[0-9A-Fa-f]*:' /etc/resolv.conf 2>/dev/null || true)"
  if [[ "${n:-0}" == 0 ]]; then
    if [[ "${r6:-0}" != 0 ]]; then
      note=", and resolv.conf lists ${r6} IPv6 resolver(s) nothing here can reach"
    fi
    echo "ipv6: no global address${note}. The node is IPv4-only either way; Xray is still closed off IPv6 in case the provider turns it on"
    return 0
  fi
  echo "ipv6: ${n} global address(es). Xray is kept off IPv6 by its config and by the firewall"
}

# --------------------------------------------------------------- callers

IMAGE_REPAIRED=(ufw hostname swap fwupd)
IMAGE_REPORTED=(iface ipv6)

# image_report: one line per item, as found. Changes nothing. Returns the
# worst state: 0 nothing to repair, 1 something a repair would change,
# 2 something that needs a person.
image_report() {
  local item msg rc worst=0
  for item in "${IMAGE_REPAIRED[@]}" "${IMAGE_REPORTED[@]}"; do
    rc=0
    msg="$("image_${item}_state")" || rc=$?
    case "$rc" in
      0) echo "ok      $msg" ;;
      1) echo "REPAIR  $msg" ;;
      *) echo "LOOK    $msg" ;;
    esac
    if [[ "$rc" -gt "$worst" ]]; then
      worst="$rc"
    fi
  done
  return "$worst"
}

# image_repair: repair what is found, item by item, and say what was
# done. Never fails the caller: a repair that could not be made is a
# WARNING, and the report afterwards shows it still standing.
image_repair() {
  local item msg rc
  for item in "${IMAGE_REPAIRED[@]}"; do
    rc=0
    msg="$("image_${item}_state")" || rc=$?
    if [[ "$rc" == 1 ]]; then
      echo "  found: $msg"
      "image_${item}_fix" || true
    fi
  done
}

# The installer's own call, on a fresh node, before any package is
# installed: iptables-persistent removes ufw and leaves its DROP policies
# standing, and from then on the certificate challenge on port 80 and
# every engine port are closed.
prepare_provider_image() {
  echo "Checking what this box's image brought along (ufw, hostname, swap, firmware timer)..."
  image_repair
  image_report | sed 's/^/  /' || true
}

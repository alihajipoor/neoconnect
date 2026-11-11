#!/bin/bash
# prep.sh <verb> ...   Runs on the box being built, before the installer.
#
#   inventory <reality dest host> <panel name> <panel address> <grpc port>
#   mask-upgrades
#   packages
#   ports                 three free random ports: SS=.. WG=.. OVPN=..
#   certs <name1> <name2> one certificate per name, by webroot
#
# Each verb is safe to run twice.
set -uo pipefail
verb=${1:-}
shift || true

case "$verb" in
  inventory)
    DEST=${1:?dest host}
    PNAME=${2:?panel name}
    PADDR=${3:?panel address}
    GPORT=${4:?grpc port}
    bad=0
    ID=""
    PRETTY_NAME=""
    # shellcheck source=/dev/null
    . /etc/os-release
    echo "os: $PRETTY_NAME, kernel $(uname -r), $(uname -m), $(nproc) cpu, $(free -m | awk '/^Mem:/{print $2}') MB, swap $(free -m | awk '/^Swap:/{print $2}') MB, disk $(df -h / | awk 'NR==2{print $4}') free"
    case "$ID" in ubuntu | debian) ;; *) echo "FAIL not Ubuntu or Debian"; bad=1 ;; esac
    echo "default interface: $(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1); global IPv6: $(ip -6 addr show scope global | grep -c inet6)"
    echo "/tmp: $(findmnt -no FSTYPE /tmp 2>/dev/null || echo on-root)"
    # A provider resolver that refused queries once stalled REALITY for
    # five seconds per connection, and the installer copies the first
    # nameserver into nginx.
    for n in "$DEST" "$PNAME" api.github.com acme-v02.api.letsencrypt.org; do
      s=$(date +%s%N)
      if getent ahostsv4 "$n" >/dev/null 2>&1; then
        ms=$((($(date +%s%N) - s) / 1000000))
        echo "lookup $n: ok ${ms} ms"
        [ "$ms" -lt 2000 ] || { echo "FAIL lookup of $n took over 2 s"; bad=1; }
      else
        echo "FAIL lookup $n"
        bad=1
      fi
    done
    timedatectl show -p NTPSynchronized --value | grep -qx yes && echo "clock: in sync" || { echo "FAIL clock not in sync"; bad=1; }
    if timeout 5 bash -c "cat </dev/null >/dev/tcp/$PADDR/$GPORT" 2>/dev/null; then echo "panel control port: reachable"; else echo "FAIL panel control port unreachable"; bad=1; fi
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$PNAME/api/health/ip")
    [ "$code" = 200 ] && echo "panel API by its own name: 200" || { echo "FAIL panel API by name gave $code"; bad=1; }
    echo "listening now: $(ss -tulnH | awk '{print $1"/"$5}' | sed 's/.*://; s/^/:/' | sort -u | tr '\n' ' ')"
    grep -E '^(PasswordAuthentication|PermitRootLogin)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | sed 's/^/sshd (left as it is): /'
    exit $bad
    ;;

  mask-upgrades)
    # On a fresh boot apt-daily holds the dpkg lock for minutes, inside the
    # 15 minutes the install token lives; and an upgrade later restarts
    # nginx, OpenVPN or strongSwan under live sessions. Masked means
    # security updates are a manual job from now on.
    for u in apt-daily-upgrade.timer apt-daily.timer unattended-upgrades.service; do
      systemctl mask --now "$u" >/dev/null 2>&1 || true
    done
    for _ in $(seq 1 60); do
      fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1 || break
      sleep 5
    done
    systemctl reset-failed >/dev/null 2>&1 || true
    for u in apt-daily-upgrade.timer apt-daily.timer unattended-upgrades.service; do
      echo "$u: $(systemctl is-enabled "$u" 2>&1 | head -1)"
    done
    if fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1; then echo "FAIL dpkg lock still held"; exit 1; fi
    echo "dpkg lock: free"
    ;;

  packages)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/root/nx-apt.log 2>&1
    apt-get install -y -qq curl wget jq ca-certificates gnupg iproute2 bind9-dnsutils tmux nginx certbot \
      wireguard wireguard-tools openvpn strongswan strongswan-swanctl libcharon-extra-plugins \
      iptables iptables-persistent fail2ban psmisc >>/root/nx-apt.log 2>&1 || { tail -5 /root/nx-apt.log; echo "FAIL apt install"; exit 1; }
    # Swap only on a small box: every 1 GB server in the fleet has 2 GB.
    if [ "$(free -m | awk '/^Mem:/{print $2}')" -le 1100 ] && [ "$(swapon --noheadings | wc -l)" = 0 ]; then
      fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
      grep -q '^/swapfile ' /etc/fstab || echo "/swapfile none swap sw 0 0" >>/etc/fstab
      echo "swap: 2G added"
    fi
    # OpenSSH 10 logs failed logins from a second process, sshd-session.
    # A jail that matches sshd alone missed 13 of 22 failures.
    printf '[sshd]\nenabled = true\nbackend = systemd\njournalmatch = _SYSTEMD_UNIT=ssh.service + _COMM=sshd + _COMM=sshd-session\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' >/etc/fail2ban/jail.d/neoxify-sshd.local
    fail2ban-client -t >/dev/null 2>&1 && systemctl restart fail2ban
    sleep 2
    echo "fail2ban sshd jail: $(fail2ban-client get sshd journalmatch 2>&1 | tr '\n' ' ')"
    for p in nginx certbot openvpn strongswan fail2ban; do printf '%s %s\n' "$p" "$(dpkg-query -W -f='${Version}' "$p" 2>/dev/null)"; done
    echo "hostname (left as it is unless it carries a brand word): $(hostname | grep -qiE 'neox|vpn|proxy|node' && echo HAS-BRAND-WORD || echo generic)"
    ;;

  ports)
    pick() {
      local p
      while true; do
        p=$((20000 + RANDOM % 40000))
        ss -tulnH | grep -q ":$p " && continue
        case " $1 " in *" $p "*) continue ;; esac
        echo "$p"
        return
      done
    }
    a=$(pick "")
    b=$(pick "$a")
    c=$(pick "$a $b")
    echo "SS=$a WG=$b OVPN=$c"
    ;;

  certs)
    L1=${1:?first name}
    L2=${2:?second name}
    # One name per certificate, never two of our names on one: the public
    # CT logs would publish the pair. The first is RSA because IKEv2 needs
    # it. By webroot, so renewal never has to stop a listener, and the
    # installer finds the first one and asks nothing.
    install -d -m 755 /var/www/html/.well-known/acme-challenge
    systemctl is-active --quiet nginx || systemctl start nginx
    [ -d "/etc/letsencrypt/live/$L1" ] || certbot certonly --webroot -w /var/www/html --non-interactive --agree-tos \
      --register-unsafely-without-email --cert-name "$L1" --key-type rsa --rsa-key-size 2048 -d "$L1" >>/root/nx-certbot.log 2>&1
    [ -d "/etc/letsencrypt/live/$L2" ] || certbot certonly --webroot -w /var/www/html --non-interactive --agree-tos \
      --register-unsafely-without-email --cert-name "$L2" -d "$L2" >>/root/nx-certbot.log 2>&1
    bad=0
    for n in "$L1" "$L2"; do
      f=/etc/letsencrypt/renewal/$n.conf
      if [ -s "/etc/letsencrypt/live/$n/fullchain.pem" ] && grep -q '^authenticator = webroot' "$f" 2>/dev/null; then
        echo "certificate ok: webroot, $(grep -E '^key_type' "$f" | tr -d ' '), expires $(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$n/fullchain.pem" | cut -d= -f2)"
      else
        echo "FAIL certificate for one of the names"
        tail -3 /root/nx-certbot.log
        bad=1
      fi
    done
    grep -q '^key_type = rsa' "/etc/letsencrypt/renewal/$L1.conf" 2>/dev/null || { echo "FAIL the first certificate is not RSA (IKEv2 needs RSA)"; bad=1; }
    exit $bad
    ;;

  *)
    echo "usage: prep.sh inventory|mask-upgrades|packages|ports|certs ..." >&2
    exit 2
    ;;
esac

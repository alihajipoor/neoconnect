#!/usr/bin/env bash
# Installs and manages the main panel server (backend + admin panel +
# Postgres + Redis via Docker Compose, fronted by host nginx + Let's
# Encrypt). Assumes it's being run from inside a checked-out copy of the
# repo (installer/install.sh -> here), since docker compose needs the
# actual source tree (Dockerfiles, prisma schema, etc.) to build from.
set -euo pipefail

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROD_COMPOSE="$REPO_ROOT/infra/docker-compose.prod.yml"
PROD_ENV="$REPO_ROOT/infra/.env"

install_docker_if_missing() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "Docker is already installed."
    return
  fi
  echo "Installing Docker Engine + Compose plugin..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
}

install_nginx_certbot_if_missing() {
  if ! command -v nginx >/dev/null 2>&1; then
    echo "Installing nginx..."
    apt-get install -y -qq nginx
  fi
  if ! command -v certbot >/dev/null 2>&1; then
    echo "Installing certbot..."
    apt-get install -y -qq certbot python3-certbot-nginx
  fi
}

generate_panel_secrets() {
  if [[ -f "$PROD_ENV" ]]; then
    echo "infra/.env already exists, keeping existing secrets."
    return
  fi
  echo "Generating random secrets into infra/.env..."
  local postgres_password jwt_access jwt_refresh
  postgres_password="$(openssl rand -hex 24)"
  jwt_access="$(openssl rand -hex 32)"
  jwt_refresh="$(openssl rand -hex 32)"
  cat > "$PROD_ENV" <<EOF
POSTGRES_PASSWORD=$postgres_password
JWT_ACCESS_SECRET=$jwt_access
JWT_REFRESH_SECRET=$jwt_refresh
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
EOF
  chmod 600 "$PROD_ENV"
}

configure_nginx_and_tls() {
  local domain="$1" email="$2"
  install -d -m 755 /var/www/html
  sed "s/__DOMAIN__/$domain/g" "$SCRIPT_DIR/assets/nginx-panel.conf.template" > "/etc/nginx/sites-available/neoxify-panel"
  ln -sf /etc/nginx/sites-available/neoxify-panel /etc/nginx/sites-enabled/neoxify-panel
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl reload nginx

  echo "Requesting a Let's Encrypt certificate for $domain..."
  if ! certbot --nginx -d "$domain" -m "$email" --agree-tos --non-interactive --redirect; then
    cat >&2 <<EOF

WARNING: certificate issuance failed. This almost always means the
domain doesn't resolve to this server's public IP yet, or port 80/443
isn't reachable from the internet. The panel is still up over plain
HTTP on port 80 for now — fix DNS and re-run:
  sudo certbot --nginx -d $domain -m $email --agree-tos --redirect
EOF
  fi
}

seed_first_admin() {
  echo
  read -r -p "Admin email for the first SUPERADMIN account: " admin_email
  local admin_password
  admin_password="$(openssl rand -base64 18 | tr -d '=+/' | cut -c1-20)"
  docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" exec -T \
    -e SEED_ADMIN_EMAIL="$admin_email" -e SEED_ADMIN_PASSWORD="$admin_password" \
    backend node dist-seed/seed.js

  cat <<EOF

  Admin login:
    email:    $admin_email
    password: $admin_password

  Save this now -- it will not be shown again. Change it after first
  login via PATCH /admins/:id.
EOF
}

action_install_panel() {
  require_root
  detect_os
  install_base_deps
  install_docker_if_missing
  install_nginx_certbot_if_missing
  generate_panel_secrets

  echo
  read -r -p "Domain name pointed at this server's IP (e.g. panel.example.com): " domain
  read -r -p "Email for Let's Encrypt renewal notices: " email

  # Recorded now, not at the end: if anything below fails partway through,
  # a re-run should land in the panel management menu (which can retry
  # the failed step) rather than repeat this entire interactive prompt
  # sequence and rebuild everything from scratch.
  install -d -m 755 /etc/neoxify
  echo "panel" > /etc/neoxify/role

  echo "Building and starting the panel stack (this can take a few minutes on first run)..."
  docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" up -d --build

  echo "Waiting for the backend to become healthy..."
  local tries=0
  until curl -fsS http://127.0.0.1:4000/health >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [[ $tries -gt 60 ]]; then
      echo "ERROR: backend did not become healthy in time. Check: docker compose -f $PROD_COMPOSE logs backend" >&2
      exit 1
    fi
    sleep 2
  done

  configure_nginx_and_tls "$domain" "$email"
  seed_first_admin
  echo
  echo "Panel installed. Visit: https://$domain"
}

action_update_panel() {
  require_root
  echo "Pulling latest source changes is up to you (git pull); rebuilding and restarting containers now..."
  docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" up -d --build
}

action_status_panel() {
  docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" ps
  echo
  docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" logs --tail 50
}

action_seed_admin_panel() {
  require_root
  seed_first_admin
}

action_uninstall_panel() {
  require_root
  read -r -p "This stops and removes the panel stack. Also delete the database volume? [y/N]: " purge
  docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" down $( [[ "${purge,,}" == "y" ]] && echo "--volumes" )
  rm -f /etc/nginx/sites-enabled/neoxify-panel /etc/nginx/sites-available/neoxify-panel
  systemctl reload nginx || true
  rm -f /etc/neoxify/role
  echo "Panel stack stopped. infra/.env and the repo checkout were left in place."
}

print_panel_menu() {
  cat <<'EOF'

  NeoConnect Panel Server
  ------------------------
  1) View status / logs
  2) Rebuild and restart (after a git pull)
  3) Seed another admin account
  4) Uninstall
  5) Exit

EOF
}

run_panel_menu() {
  while true; do
    print_panel_menu
    read -r -p "Choose an option [1-5]: " choice
    case "$choice" in
      1) action_status_panel ;;
      2) action_update_panel ;;
      3) action_seed_admin_panel ;;
      4) action_uninstall_panel ;;
      5) exit 0 ;;
      *) echo "Invalid option: $choice" ;;
    esac
  done
}

#!/usr/bin/env bash
# One-time setup of Khapee on a fresh Ubuntu server (Oracle Cloud Always Free,
# or any Ubuntu 22.04/24.04 machine). Run as the default user, with sudo:
#
#   curl -fsSL https://raw.githubusercontent.com/khapee-team/khapee/main/deploy/setup.sh | bash
#
# The repository is private, so the first run makes a read-only deploy key and
# stops to ask you to add it on GitHub; run the same command again afterwards.
# Safe to run any number of times.
set -euo pipefail

REPO_SSH="git@github.com:khapee-team/khapee.git"
DIR="/opt/khapee"
KEY="$HOME/.ssh/khapee_deploy"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/6  Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER" || true

say "2/6  Firewall: ports 80 and 443"
# Oracle's Ubuntu images ship iptables rules that drop everything but SSH, on
# top of the VCN security list. Both have to allow 80/443; this is the half
# that lives on the machine (the other is in the Oracle console, see README).
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
  fi
done
if ! sudo iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null; then
  sudo iptables -I INPUT 1 -p udp --dport 443 -j ACCEPT
fi
if command -v netfilter-persistent >/dev/null; then
  sudo netfilter-persistent save >/dev/null
else
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null
  sudo netfilter-persistent save >/dev/null
fi

say "3/6  Access to the private repository"
mkdir -p "$HOME/.ssh"
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N '' -C "khapee-server" -f "$KEY" >/dev/null
fi
if ! grep -q "Host github-khapee" "$HOME/.ssh/config" 2>/dev/null; then
  cat >> "$HOME/.ssh/config" <<CFG
Host github-khapee
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
CFG
  chmod 600 "$HOME/.ssh/config"
fi
ssh-keyscan -t ed25519 github.com 2>/dev/null >> "$HOME/.ssh/known_hosts"
sort -u -o "$HOME/.ssh/known_hosts" "$HOME/.ssh/known_hosts"
# GitHub answers a working key with a greeting and exit code 1, so the words
# are what is checked, not the status.
github_says="$(ssh -o BatchMode=yes -T github-khapee 2>&1 || true)"
if ! grep -q "successfully authenticated" <<<"$github_says"; then
  echo
  echo "  Add this key on GitHub, then run this script again:"
  echo "  github.com/khapee-team/khapee → Settings → Deploy keys → Add deploy key"
  echo "  (title: khapee-server, leave 'Allow write access' OFF)"
  echo
  cat "$KEY.pub"
  echo
  exit 0
fi

say "4/6  The code"
sudo mkdir -p "$DIR"
sudo chown "$USER":"$USER" "$DIR"
if [ ! -d "$DIR/.git" ]; then
  git clone "${REPO_SSH/git@github.com/github-khapee}" "$DIR"
else
  git -C "$DIR" fetch --quiet origin main
  git -C "$DIR" reset --quiet --hard origin/main
fi

say "5/6  Settings"
if [ ! -f "$DIR/deploy/.env" ]; then
  cp "$DIR/deploy/.env.example" "$DIR/deploy/.env"
  chmod 600 "$DIR/deploy/.env"
fi
if ! grep -qE '^KHAPEE_SECRET=.{16,}' "$DIR/deploy/.env"; then
  echo
  echo "  Fill in $DIR/deploy/.env first — at least KHAPEE_SECRET, copied from"
  echo "  Render so nobody is signed out and every phone keeps its alerts:"
  echo
  echo "    nano $DIR/deploy/.env"
  echo
  echo "  Then run this script again."
  exit 0
fi

say "6/6  Start, and keep it updated"
sudo docker compose -f "$DIR/deploy/docker-compose.yml" up -d --build

sudo tee /etc/systemd/system/khapee-update.service >/dev/null <<UNIT
[Unit]
Description=Deploy new Khapee commits, and back up the database once a day
After=docker.service network-online.target
[Service]
Type=oneshot
User=$USER
ExecStart=$DIR/deploy/update.sh
UNIT
sudo tee /etc/systemd/system/khapee-update.timer >/dev/null <<UNIT
[Unit]
Description=Check for new Khapee commits every two minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now khapee-update.timer >/dev/null

say "Done."
echo "  Khapee is starting (the first build takes a few minutes)."
echo "  Health:        sudo docker compose -f $DIR/deploy/docker-compose.yml exec app node -e \"fetch('http://127.0.0.1:8000/api/health').then(r=>r.text()).then(console.log)\""
echo "  Logs:          sudo docker compose -f $DIR/deploy/docker-compose.yml logs -f app"
echo "  Order alerts:  sudo docker compose -f $DIR/deploy/docker-compose.yml logs app | grep '\[alerts\]'"

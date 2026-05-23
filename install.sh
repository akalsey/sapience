#!/usr/bin/env bash
# Sapience Suite installer
# Checks for required plugins and cron jobs, installs/registers anything missing.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
info() { echo -e "  $*"; }
header() { echo -e "\n${BOLD}$*${RESET}"; }

confirm() {
  local prompt="$1"
  local default="${2:-n}"
  local yn_hint
  if [[ "$default" == "y" ]]; then yn_hint="[Y/n]"; else yn_hint="[y/N]"; fi
  read -r -p "$(echo -e "${YELLOW}?${RESET} ${prompt} ${yn_hint} ")" answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ── sanity check ────────────────────────────────────────────────────────────
if ! command -v openclaw &>/dev/null; then
  echo -e "${RED}Error:${RESET} 'openclaw' command not found. Install OpenClaw first."
  exit 1
fi

echo -e "${BOLD}Sapience Suite Installer${RESET}"
echo "Checks plugins and cron jobs, installs anything missing."

# ── plugins ─────────────────────────────────────────────────────────────────
header "Checking plugins..."

PLUGIN_LIST=$(openclaw plugins list 2>&1)

declare -A PLUGIN_PACKAGES=(
  [sapience-thinking]="npm:@akalsey/openclaw-thinking"
  [sapience]="npm:@akalsey/openclaw-sapience"
  [sapience-feedback]="npm:@akalsey/openclaw-feedback"
  [sapience-goals]="npm:@akalsey/openclaw-goals"
)

PLUGINS_TO_INSTALL=()

for plugin_id in sapience-thinking sapience sapience-feedback sapience-goals; do
  if echo "$PLUGIN_LIST" | grep -q "$plugin_id"; then
    ok "Plugin $plugin_id is installed"
  else
    warn "Plugin $plugin_id is NOT installed"
    PLUGINS_TO_INSTALL+=("$plugin_id")
  fi
done

INSTALLED_COUNT=0
if [[ ${#PLUGINS_TO_INSTALL[@]} -gt 0 ]]; then
  echo ""
  warn "Missing plugins: ${PLUGINS_TO_INSTALL[*]}"
  if confirm "Install missing plugins now?"; then
    for plugin_id in "${PLUGINS_TO_INSTALL[@]}"; do
      pkg="${PLUGIN_PACKAGES[$plugin_id]}"
      echo "  Installing $pkg..."
      openclaw plugins install "$pkg"
      ok "Installed $plugin_id"
      ((INSTALLED_COUNT++)) || true
    done
  else
    info "Skipping plugin installation. Re-run this script after installing manually."
  fi
fi

if [[ $INSTALLED_COUNT -gt 0 ]]; then
  echo ""
  warn "Plugins were installed. You may need to restart the OpenClaw gateway for them to activate."
  confirm "Continue setting up cron jobs now (gateway restart not required for cron)?" y || exit 0
fi

# ── cron jobs ────────────────────────────────────────────────────────────────
header "Checking cron jobs..."

CRON_LIST=$(openclaw cron list 2>&1)

declare -A CRON_NAMES=(
  [thinking]="sapience-thinking-pass"
  [routing]="sapience-routing-pass"
  [goals]="sapience-goals-check-pass"
)

declare -A CRON_TOOLS=(
  [thinking]="get_thinking_context,record_thinking_output"
  [routing]="process_proposals"
  [goals]="check_goals"
)

declare -A CRON_MESSAGES=(
  [thinking]="You are running a scheduled thinking pass. Call get_thinking_context() to receive your context and instructions. If it returns {status:skip}, reply with SILENT_REPLY_TOKEN and stop. Otherwise review the context carefully, then call record_thinking_output() with your proposals. Do not produce any other output."
  [routing]="You are the sapience routing agent. Call process_proposals() to route new thinking pass proposals. Reply SILENT_REPLY_TOKEN after the tool call."
  [goals]="You are the goals tracking agent. Call check_goals() to process new goals and deliver weekly status updates. Reply SILENT_REPLY_TOKEN after the tool call."
)

CRON_SCHEDULE="*/15 * * * *"

CRONS_TO_ADD=()

for key in thinking routing goals; do
  name="${CRON_NAMES[$key]}"
  if echo "$CRON_LIST" | grep -q "$name"; then
    ok "Cron job '$name' exists"
  else
    warn "Cron job '$name' is NOT registered"
    CRONS_TO_ADD+=("$key")
  fi
done

if [[ ${#CRONS_TO_ADD[@]} -gt 0 ]]; then
  echo ""
  warn "Missing cron jobs: $(for k in "${CRONS_TO_ADD[@]}"; do echo -n "${CRON_NAMES[$k]} "; done)"
  if confirm "Register missing cron jobs now?"; then
    for key in "${CRONS_TO_ADD[@]}"; do
      name="${CRON_NAMES[$key]}"
      tools="${CRON_TOOLS[$key]}"
      message="${CRON_MESSAGES[$key]}"
      echo "  Registering $name..."
      openclaw cron add \
        --name "$name" \
        --cron "$CRON_SCHEDULE" \
        --session isolated \
        --tools "$tools" \
        --message "$message" \
        --timeout-seconds 120
      ok "Registered $name"
    done
  else
    info "Skipping cron registration. You can register manually — see README for cron commands."
    echo ""
    info "To register manually:"
    for key in "${CRONS_TO_ADD[@]}"; do
      name="${CRON_NAMES[$key]}"
      tools="${CRON_TOOLS[$key]}"
      message="${CRON_MESSAGES[$key]}"
      echo ""
      echo "  openclaw cron add \\"
      echo "    --name \"$name\" \\"
      echo "    --cron \"$CRON_SCHEDULE\" \\"
      echo "    --session isolated \\"
      echo "    --tools \"$tools\" \\"
      echo "    --message \"$message\" \\"
      echo "    --timeout-seconds 120"
    done
  fi
fi

# ── done ─────────────────────────────────────────────────────────────────────
header "Done."
echo ""
echo "Sapience suite runs on a 15-minute cron. Within the first hour you'll see"
echo "your first thinking proposals delivered to your active session."
echo ""
echo "For configuration options, see each plugin's README."

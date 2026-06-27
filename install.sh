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
  [sapience-thinking]="npm:@akalsey/sapience-thinking"
  [sapience]="npm:@akalsey/sapience"
  [sapience-feedback]="npm:@akalsey/sapience-feedback"
  [sapience-goals]="npm:@akalsey/sapience-goals"
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

read -r -p "$(echo -e "  Agent to run sapience crons under [main/all/<name>] (default: main): ")" CRON_AGENT_INPUT
CRON_AGENT_INPUT="${CRON_AGENT_INPUT:-main}"

# Detect main agent's model and warn if it's a known lightweight model
AGENT_MODEL=$(openclaw agents list 2>/dev/null | grep -A5 "^- ${CRON_AGENT_INPUT:-main}" | grep "Model:" | awk '{print $2}' | head -1)
if [[ -n "$AGENT_MODEL" ]] && echo "$AGENT_MODEL" | grep -qiE 'flash$|flash-lite|lite$|mini|nano'; then
  warn "Agent '${CRON_AGENT_INPUT:-main}' uses model: $AGENT_MODEL"
  info "Lightweight/flash models are often unreliable at tool calls. Sapience crons need a"
  info "model that will consistently call tools — consider a full-size model for cron use."
fi
read -r -p "$(echo -e "  Model for sapience crons (default: anthropic/claude-haiku-4-5-20251001): ")" CRON_MODEL_INPUT
CRON_MODEL_INPUT="${CRON_MODEL_INPUT:-anthropic/claude-haiku-4-5-20251001}"

# Resolve agent list
CRON_AGENTS=()
if [[ "$CRON_AGENT_INPUT" == "all" ]]; then
  while IFS= read -r aid; do
    [[ -n "$aid" ]] && CRON_AGENTS+=("$aid")
  done < <(openclaw agents list 2>/dev/null | grep "^- " | awk '{print $2}')
  if [[ ${#CRON_AGENTS[@]} -eq 0 ]]; then
    warn "Could not enumerate agents; defaulting to 'main'."
    CRON_AGENTS=(main)
  else
    info "Found agents: ${CRON_AGENTS[*]}"
  fi
else
  CRON_AGENTS=("$CRON_AGENT_INPUT")
fi

MULTI_AGENT=false
[[ ${#CRON_AGENTS[@]} -gt 1 ]] && MULTI_AGENT=true

CRON_LIST=$(openclaw cron list --json 2>&1)

declare -A CRON_BASE_NAMES=(
  [thinking]="sapience-thinking"
  [routing]="sapience-routing"
  [goals]="sapience-goals-check"
)

declare -A CRON_MESSAGES=(
  [thinking]="You are running a scheduled thinking pass. Call get_thinking_context() to receive your context and instructions. If it returns {status:skip}, reply with SILENT_REPLY_TOKEN and stop. Otherwise review the context carefully, then call record_thinking_output() with your proposals. Do not produce any other output."
  [routing]="You are the sapience routing agent. Call process_proposals() to route new thinking pass proposals. Reply SILENT_REPLY_TOKEN after the tool call."
  [goals]="You are the goals tracking agent. Call check_goals() to process new goals and deliver weekly status updates. Reply SILENT_REPLY_TOKEN after the tool call."
)

cron_name() {
  local base="$1" agent="$2"
  if [[ "$MULTI_AGENT" == "true" ]]; then echo "${base}-${agent}"; else echo "$base"; fi
}

CRON_SCHEDULE="*/15 * * * *"

# CRONS_TO_ADD stores "key:agent" pairs
CRONS_TO_ADD=()

for agent in "${CRON_AGENTS[@]}"; do
  for key in thinking routing goals; do
    name=$(cron_name "${CRON_BASE_NAMES[$key]}" "$agent")
    if echo "$CRON_LIST" | grep -q "\"$name\""; then
      ok "Cron job '$name' exists"
    else
      warn "Cron job '$name' is NOT registered"
      CRONS_TO_ADD+=("${key}:${agent}")
    fi
  done
done

if [[ ${#CRONS_TO_ADD[@]} -gt 0 ]]; then
  echo ""
  warn "Missing cron jobs: $(for item in "${CRONS_TO_ADD[@]}"; do key="${item%%:*}"; agent="${item##*:}"; echo -n "$(cron_name "${CRON_BASE_NAMES[$key]}" "$agent") "; done)"
  if confirm "Register missing cron jobs now?"; then
    for item in "${CRONS_TO_ADD[@]}"; do
      key="${item%%:*}"
      agent="${item##*:}"
      name=$(cron_name "${CRON_BASE_NAMES[$key]}" "$agent")

      message="${CRON_MESSAGES[$key]}"
      echo "  Registering $name (agent: $agent)..."
      openclaw cron add \
        --name "$name" \
        --cron "$CRON_SCHEDULE" \
        --session isolated \
        --agent "$agent" \
        --model "$CRON_MODEL_INPUT" \
        --no-deliver \
        --message "$message" \
        --timeout-seconds 120
      ok "Registered $name"
    done
  else
    info "Skipping cron registration. You can register manually — see README for cron commands."
    echo ""
    info "To register manually:"
    for item in "${CRONS_TO_ADD[@]}"; do
      key="${item%%:*}"
      agent="${item##*:}"
      name=$(cron_name "${CRON_BASE_NAMES[$key]}" "$agent")

      message="${CRON_MESSAGES[$key]}"
      echo ""
      echo "  openclaw cron add \\"
      echo "    --name \"$name\" \\"
      echo "    --cron \"$CRON_SCHEDULE\" \\"
      echo "    --session isolated \\"
      echo "    --agent \"$agent\" \\"
      echo "    --model \"$CRON_MODEL_INPUT\" \\"
      echo "    --no-deliver \\"
      echo "    --message \"$message\" \\"
      echo "    --timeout-seconds 120"
    done
  fi
fi

# ── memory configuration ──────────────────────────────────────────────────────
header "Checking memory configuration..."

MEMORY_WIKI_AVAILABLE=false
if echo "$PLUGIN_LIST" | grep -q "memory-wiki"; then
  ok "Plugin memory-wiki is installed"
  MEMORY_WIKI_AVAILABLE=true
else
  warn "Plugin memory-wiki is NOT installed"
  info "memory-wiki enables structured claim tracking for behavioral corrections"
  if confirm "Install memory-wiki now?"; then
    echo "  Installing clawhub:memory-wiki..."
    openclaw plugins install clawhub:memory-wiki
    ok "Installed memory-wiki"
    MEMORY_WIKI_AVAILABLE=true
  else
    info "Skipping memory-wiki. memory-wiki config checks will be skipped."
  fi
fi

CONFIG_KEYS_ORDER=(dreaming)
if [[ "$MEMORY_WIKI_AVAILABLE" == "true" ]]; then
  CONFIG_KEYS_ORDER+=(vault_mode bridge_enabled corpus)
fi

declare -A CONFIG_PATHS=(
  [dreaming]="plugins.memory-core.dreaming.enabled"
  [vault_mode]="plugins.memory-wiki.vaultMode"
  [bridge_enabled]="plugins.memory-wiki.bridge.enabled"
  [corpus]="plugins.memory-wiki.search.corpus"
)

declare -A CONFIG_EXPECTED=(
  [dreaming]="true"
  [vault_mode]="bridge"
  [bridge_enabled]="true"
  [corpus]="all"
)

declare -A CONFIG_SET_CMDS=(
  [dreaming]="openclaw config set plugins.memory-core.dreaming.enabled true --strict-json"
  [vault_mode]="openclaw config set plugins.memory-wiki.vaultMode '\"bridge\"'"
  [bridge_enabled]="openclaw config set plugins.memory-wiki.bridge.enabled true --strict-json"
  [corpus]="openclaw config set plugins.memory-wiki.search.corpus '\"all\"'"
)

CONFIGS_TO_FIX=()

for key in "${CONFIG_KEYS_ORDER[@]}"; do
  path="${CONFIG_PATHS[$key]}"
  expected="${CONFIG_EXPECTED[$key]}"
  actual=$(openclaw config get "$path" --json 2>/dev/null | tr -d '"')
  if [[ "$actual" == "$expected" ]]; then
    ok "Config $path = $expected"
  else
    warn "Config $path is wrong (got: '${actual:-<absent>}', need: '$expected')"
    CONFIGS_TO_FIX+=("$key")
  fi
done

if [[ ${#CONFIGS_TO_FIX[@]} -gt 0 ]]; then
  echo ""
  if confirm "Apply missing memory configuration settings now?"; then
    for key in "${CONFIGS_TO_FIX[@]}"; do
      eval "${CONFIG_SET_CMDS[$key]}"
      ok "Set ${CONFIG_PATHS[$key]}"
    done
  else
    info "Skipping memory configuration. Sapience corrections may not persist across sessions."
    echo ""
    info "To configure manually:"
    for key in "${CONFIGS_TO_FIX[@]}"; do
      echo "  ${CONFIG_SET_CMDS[$key]}"
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

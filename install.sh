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

# ── sanity checks ───────────────────────────────────────────────────────────
# macOS ships bash 3.2, which rejects the associative arrays below — with
# set -e the script would die right after the first header. Fail with a clear
# message (and a hint) instead.
if (( BASH_VERSINFO[0] < 4 )); then
  echo "Error: this script needs bash >= 4 (you have ${BASH_VERSION})."
  echo "On macOS: brew install bash, then run: $(command -v bash 2>/dev/null || echo /opt/homebrew/bin/bash) $0"
  exit 1
fi

if ! command -v openclaw &>/dev/null; then
  echo -e "${RED}Error:${RESET} 'openclaw' command not found. Install OpenClaw first."
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo -e "${RED}Error:${RESET} 'node' not found (needed to parse openclaw's JSON output)."
  exit 1
fi

echo -e "${BOLD}Sapience Suite Installer${RESET}"
echo "Checks plugins and cron jobs, installs anything missing."

# ── plugins ─────────────────────────────────────────────────────────────────
header "Checking plugins..."

# Prefer JSON: the human table wraps long ids across lines, and a substring
# grep ("sapience" matches "sapience-thinking") reports absent plugins as
# installed. Fall back to an anchored grep if --json is unsupported.
PLUGIN_LIST_JSON=$(openclaw plugins list --json 2>/dev/null || true)
PLUGIN_LIST=$(openclaw plugins list 2>&1)

plugin_installed() {
  local plugin_id="$1"
  if [[ -n "$PLUGIN_LIST_JSON" ]]; then
    echo "$PLUGIN_LIST_JSON" | node -e '
      let raw = "";
      process.stdin.on("data", (d) => raw += d);
      process.stdin.on("end", () => {
        let parsed; try { parsed = JSON.parse(raw); } catch { process.exit(2); }
        const list = Array.isArray(parsed) ? parsed : parsed.plugins ?? [];
        process.exit(list.some((p) => p?.id === process.argv[1]) ? 0 : 1);
      });
    ' "$plugin_id"
  else
    echo "$PLUGIN_LIST" | grep -qE "(^|[^a-z0-9-])${plugin_id}([^a-z0-9-]|$)"
  fi
}

declare -A PLUGIN_PACKAGES=(
  [sapience-thinking]="npm:@akalsey/sapience-thinking"
  [sapience]="npm:@akalsey/sapience"
  [sapience-feedback]="npm:@akalsey/sapience-feedback"
  [sapience-goals]="npm:@akalsey/sapience-goals"
)

PLUGINS_TO_INSTALL=()

for plugin_id in sapience-thinking sapience sapience-feedback sapience-goals; do
  if plugin_installed "$plugin_id"; then
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
  warn "Plugins were installed, but they won't register tools until the gateway restarts."
  if confirm "Restart the gateway now?" y; then
    openclaw gateway restart || warn "Gateway restart failed — restart it manually before expecting the plugins to work."
  else
    warn "Skipping restart. The crons below will run against a gateway that can't serve the plugin tools until you restart."
  fi
fi

# ── cron jobs ────────────────────────────────────────────────────────────────
header "Checking cron jobs..."

read -r -p "$(echo -e "  Agent to run sapience crons under [main/all/<name>] (default: main): ")" CRON_AGENT_INPUT
CRON_AGENT_INPUT="${CRON_AGENT_INPUT:-main}"

# No --model: crons inherit the agent's default. A pinned model that isn't in
# the gateway's agents.defaults.models allowlist fails preflight on every run.

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

# "missing" | "ok" | "invalid <reason>". Existence alone isn't health: a job
# with the right name but no payload.toolsAllow runs "ok" while the agent
# can't call the tool — the exact regression that silently disabled the suite.
cron_state() {
  local name="$1" tools="$2"
  echo "$CRON_LIST" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => raw += d);
    process.stdin.on("end", () => {
      let parsed; try { parsed = JSON.parse(raw); } catch { console.log("missing"); return; }
      const jobs = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
      const job = jobs.find((j) => j?.name === process.argv[1]);
      if (!job) { console.log("missing"); return; }
      if (job.enabled === false) { console.log("invalid disabled"); return; }
      const granted = Array.isArray(job.payload?.toolsAllow) ? job.payload.toolsAllow : [];
      const missing = process.argv[2].split(",").filter((t) => !granted.includes(t));
      if (missing.length > 0) { console.log(`invalid tools grant missing: ${missing.join(",")}`); return; }
      console.log("ok");
    });
  ' "$name" "$tools"
}

declare -A CRON_BASE_NAMES=(
  [thinking]="sapience-thinking"
  [routing]="sapience-routing"
  [goals]="sapience-goals-check"
  [delivery]="sapience-delivery"
)

# --tools becomes the job's payload.toolsAllow. Isolated cron sessions only see
# plugin tools granted here (or via a global tools.allow/alsoAllow) — without
# the grant every run completes "ok" while the agent can't call the tool.
# Keep names, tools, and messages in sync with SUITE_CRONS in
# sapience/src/doctor/inventory.ts.
declare -A CRON_TOOLS=(
  [thinking]="get_thinking_context,record_thinking_output"
  [routing]="process_proposals"
  [goals]="check_goals"
  [delivery]="get_pending_deliveries"
)

# The delivery cron is the only one whose final reply must reach the user's
# chat: cron announce delivery is the channel path stock openclaw grants
# globally-installed plugins (main-session injection is voided by the gateway's
# registration guard — openclaw PR #111131).
declare -A CRON_DELIVER_FLAG=(
  [thinking]="--no-deliver"
  [routing]="--no-deliver"
  [goals]="--no-deliver"
  [delivery]="--announce"
)

# Announce's default "last" target resolves from the MAIN session's delivery
# context. On installs where DMs are scoped to per-peer sessions
# (session.dmScope per-channel-peer), the main session never gains a route and
# announce fails closed. Set these to pin the delivery cron to an explicit
# destination, e.g. SAPIENCE_DELIVERY_CHANNEL=telegram SAPIENCE_DELIVERY_TO=<chatId>.
SAPIENCE_DELIVERY_CHANNEL="${SAPIENCE_DELIVERY_CHANNEL:-}"
SAPIENCE_DELIVERY_TO="${SAPIENCE_DELIVERY_TO:-}"

delivery_target_args() {
  local key="$1"
  if [[ "$key" == "delivery" && -n "$SAPIENCE_DELIVERY_TO" ]]; then
    echo "--channel ${SAPIENCE_DELIVERY_CHANNEL:-telegram} --to $SAPIENCE_DELIVERY_TO"
  fi
}

declare -A CRON_MESSAGES=(
  [thinking]="You are running a scheduled thinking pass. Call get_thinking_context() to receive your context and instructions. If it returns {status:skip}, reply with NO_REPLY and stop. Otherwise review the context carefully, then call record_thinking_output() with your proposals. Do not produce any other output. If the tool is not available, reply NO_REPLY and stop."
  [routing]="You are the sapience routing agent. Call process_proposals() to route new thinking pass proposals. Reply NO_REPLY after the tool call. If the tool is not available, reply NO_REPLY and stop."
  [goals]="You are the goals tracking agent. Call check_goals() to process new goals and deliver weekly status updates. Reply NO_REPLY after the tool call. If the tool is not available, reply NO_REPLY and stop."
  [delivery]="You are the sapience delivery agent. Call get_pending_deliveries() to fetch notifications that could not reach the user through the normal path. If it returns NOTHING_PENDING, reply NO_REPLY and stop. Otherwise compose ONE concise message to the user covering every pending item — lead with the most important, keep it brief, and write as the assistant speaking directly to the user; your final reply is delivered to their chat. If the tool is not available, reply NO_REPLY and stop."
)

cron_name() {
  local base="$1" agent="$2"
  if [[ "$MULTI_AGENT" == "true" ]]; then echo "${base}-${agent}"; else echo "$base"; fi
}

CRON_SCHEDULE="*/15 * * * *"

# CRONS_TO_ADD stores "key:agent" pairs
CRONS_TO_ADD=()

for agent in "${CRON_AGENTS[@]}"; do
  for key in thinking routing goals delivery; do
    name=$(cron_name "${CRON_BASE_NAMES[$key]}" "$agent")
    state=$(cron_state "$name" "${CRON_TOOLS[$key]}")
    case "$state" in
      ok)
        ok "Cron job '$name' exists and grants its tools"
        ;;
      missing)
        warn "Cron job '$name' is NOT registered"
        CRONS_TO_ADD+=("${key}:${agent}")
        ;;
      invalid*)
        warn "Cron job '$name' exists but is broken (${state#invalid })"
        if confirm "Delete and re-register '$name' with the correct tools grant?" y; then
          openclaw cron delete --name "$name" 2>/dev/null || openclaw cron remove --name "$name" 2>/dev/null \
            || warn "Could not delete '$name' automatically — delete it manually, then re-run this script."
          CRONS_TO_ADD+=("${key}:${agent}")
        fi
        ;;
    esac
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
      tools="${CRON_TOOLS[$key]}"
      echo "  Registering $name (agent: $agent)..."
      # shellcheck disable=SC2046 — delivery_target_args intentionally splits
      openclaw cron add \
        --name "$name" \
        --cron "$CRON_SCHEDULE" \
        --session isolated \
        --agent "$agent" \
        "${CRON_DELIVER_FLAG[$key]}" \
        $(delivery_target_args "$key") \
        --tools "$tools" \
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
      tools="${CRON_TOOLS[$key]}"
      echo ""
      echo "  openclaw cron add \\"
      echo "    --name \"$name\" \\"
      echo "    --cron \"$CRON_SCHEDULE\" \\"
      echo "    --session isolated \\"
      echo "    --agent \"$agent\" \\"
      echo "    ${CRON_DELIVER_FLAG[$key]} \\"
      echo "    --tools \"$tools\" \\"
      echo "    --message \"$message\" \\"
      echo "    --timeout-seconds 120"
    done
  fi
fi

# ── delivery target ───────────────────────────────────────────────────────────
# When session.dmScope isolates DMs into per-peer sessions, the agent main
# session is machine-only: proposals injected there are never seen by a human.
# Route deliveries into the operator's own conversation instead. The doctor
# re-checks this ("delivery:target") and can autofix it later — important on
# fresh installs where no conversation exists yet.
header "Checking delivery target..."

DM_SCOPE=$(openclaw config get session.dmScope 2>/dev/null | tr -d '"' | tr -d '[:space:]')
if [[ -z "$DM_SCOPE" || "$DM_SCOPE" == "main" ]]; then
  ok "DMs share the main session (dmScope ${DM_SCOPE:-default}) — deliveries reach the operator there"
else
  EXISTING_TARGET=$(openclaw config get plugins.entries.sapience.config.delivery.sessionKey 2>/dev/null | tr -d '"' | tr -d '[:space:]')
  if [[ -n "$EXISTING_TARGET" && "$EXISTING_TARGET" != "null" && "$EXISTING_TARGET" != "undefined" ]]; then
    ok "Deliveries already routed to $EXISTING_TARGET"
  else
    # Operator conversations are agent:<id>:<channel>:<rest...> keys; machine
    # sessions (main/current, cron:*, subagent:*, labels) never match.
    mapfile -t CANDIDATES < <(python3 - <<'PYEOF' 2>/dev/null
import json, os, glob
for store in glob.glob(os.path.expanduser("~/.openclaw/agents/*/sessions/sessions.json")):
    try:
        data = json.load(open(store))
    except Exception:
        continue
    rows = []
    for key, entry in data.items():
        parts = key.split(":")
        if len(parts) < 4 or parts[0] != "agent" or parts[2] in ("cron", "subagent"):
            continue
        updated = entry.get("updatedAt", 0) if isinstance(entry, dict) else 0
        rows.append((updated or 0, key))
    for _, key in sorted(rows, reverse=True)[:5]:
        print(key)
PYEOF
)
    if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
      warn "dmScope=$DM_SCOPE makes the main session machine-only, and no operator conversations exist yet"
      info "Message the assistant once from your chat app, then run: openclaw sapience doctor --fix"
    elif [[ ${#CANDIDATES[@]} -eq 1 ]]; then
      if confirm "Route suite deliveries to your conversation ${CANDIDATES[0]}?" y; then
        for pid in sapience sapience-thinking sapience-goals; do
          openclaw config set "plugins.entries.${pid}.config.delivery.sessionKey" "${CANDIDATES[0]}"
        done
        ok "Deliveries routed to ${CANDIDATES[0]}"
      fi
    else
      info "dmScope=$DM_SCOPE — deliveries should go to the operator's conversation. Recent conversations:"
      select TARGET in "${CANDIDATES[@]}" "skip"; do
        [[ "$TARGET" == "skip" || -z "$TARGET" ]] && { info "Skipped — run 'openclaw sapience doctor --fix' later."; break; }
        for pid in sapience sapience-thinking sapience-goals; do
          openclaw config set "plugins.entries.${pid}.config.delivery.sessionKey" "$TARGET"
        done
        ok "Deliveries routed to $TARGET"
        break
      done
    fi
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

# The real config path shape: plugins.entries.<id>.config.<key> — the CLI
# rejects shorter forms, so gets read nothing and sets write orphan keys.
declare -A CONFIG_PATHS=(
  [dreaming]="plugins.entries.memory-core.config.dreaming.enabled"
  [vault_mode]="plugins.entries.memory-wiki.config.vaultMode"
  [bridge_enabled]="plugins.entries.memory-wiki.config.bridge.enabled"
  [corpus]="plugins.entries.memory-wiki.config.search.corpus"
)

declare -A CONFIG_EXPECTED=(
  [dreaming]="true"
  [vault_mode]="bridge"
  [bridge_enabled]="true"
  [corpus]="all"
)

declare -A CONFIG_SET_CMDS=(
  [dreaming]="openclaw config set plugins.entries.memory-core.config.dreaming.enabled true --strict-json"
  [vault_mode]="openclaw config set plugins.entries.memory-wiki.config.vaultMode '\"bridge\"'"
  [bridge_enabled]="openclaw config set plugins.entries.memory-wiki.config.bridge.enabled true --strict-json"
  [corpus]="openclaw config set plugins.entries.memory-wiki.config.search.corpus '\"all\"'"
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

# ── core goal tool collision ─────────────────────────────────────────────────
# Core's create_goal/get_goal/update_goal track a per-thread token budget that
# dies with the session — nothing like sapience-goals' durable goal_* tools, but
# close enough in name that agents reach for create_goal when asked for a goal
# that outlives the session, and the objective is silently lost.
#
# The detection and the merged tools.deny value both come from the doctor
# (sapience/src/doctor/report.ts) — deliberately NOT reimplemented here. The
# CRON_TOOLS regression happened because this script kept its own copy of logic
# the doctor also had, and the two drifted.
header "Checking for the core goal-tool name collision..."
COLLISION=$(openclaw sapience doctor --json 2>/dev/null \
  | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      try {
        const r = JSON.parse(raw);
        const f = r.sections.flatMap((s) => s.findings).find((f) => f.id === "tools:goal-collision");
        if (f && f.severity === "warn") console.log(f.message);
      } catch { /* no report to read — stay silent and skip the offer */ }
    });
  ' 2>/dev/null || true)

if [[ -n "$COLLISION" ]]; then
  warn "$COLLISION"
  echo "  Core's goal tools mean something entirely different from goal_submit:"
  echo "  they budget tokens within one thread and vanish with the session. An"
  echo "  agent that picks create_goal for a long-running goal loses it silently."
  echo ""
  echo "  Denying them affects EVERY session on this host, not just sapience."
  echo "  Say no if this agent also does coding work and uses token budgets."
  if confirm "Deny core's create_goal/get_goal/update_goal?"; then
    openclaw sapience doctor --fix --only tools:goal-collision >/dev/null
    ok "Denied core's goal tools (merged into any existing tools.deny)."
  else
    info "Left as is. To do it later: openclaw sapience doctor --fix --only tools:goal-collision"
  fi
else
  ok "No goal-tool collision."
fi

# ── verification ─────────────────────────────────────────────────────────────
header "Verifying with 'openclaw sapience doctor'..."
if openclaw sapience doctor; then
  ok "Doctor reports healthy."
else
  warn "The doctor found problems (see above). Fix them — 'openclaw sapience doctor --fix'"
  warn "handles the auto-fixable ones — or the suite will not function."
fi

# ── done ─────────────────────────────────────────────────────────────────────
header "Done."
echo ""
echo "The suite runs on a 15-minute cron during active hours (default 08:00-20:00"
echo "local). The first routing run baselines existing proposals, so expect the"
echo "first proposals in your MAIN session's next turn roughly 30-45 minutes in —"
echo "they arrive when you next interact, not as a push."
echo ""
echo "For configuration options, see each plugin's README."

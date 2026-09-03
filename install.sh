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

# The installer never pins a --model of its own: one outside the gateway's
# agents.defaults.models allowlist fails preflight on every run. A pin an
# operator already set is carried across a replacement (see cron_model_for_name).

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

# --all is required: `cron list` hides disabled jobs, and the delivery job is
# registered disabled on purpose (sapience-poll-delivery starts it on demand).
# Without --all it reads as missing on every subsequent run.
CRON_LIST=$(openclaw cron list --all --json 2>&1)

# "missing" | "ok" | "invalid <reason>". Existence alone isn't health: a job
# with the right name but no payload.toolsAllow runs "ok" while the agent
# can't call the tool — the exact regression that silently disabled the suite.
#
# $3 is the expected enabled state ("enabled" | "disabled"). The delivery job is
# registered disabled on purpose — sapience-poll-delivery starts it on demand —
# so "disabled" is health for that one and a defect for the others.
# $4 marks a command payload, which never starts an agent turn and therefore has
# no tool grant to check.
cron_state() {
  local name="$1" tools="$2" want_enabled="${3:-enabled}" kind="${4:-agent}"
  echo "$CRON_LIST" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => raw += d);
    process.stdin.on("end", () => {
      const [name, tools, wantEnabled, kind] = process.argv.slice(1);
      let parsed; try { parsed = JSON.parse(raw); } catch { console.log("missing"); return; }
      const jobs = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
      const job = jobs.find((j) => j?.name === name);
      if (!job) { console.log("missing"); return; }
      const enabled = job.enabled !== false;
      if (enabled && wantEnabled === "disabled") { console.log("invalid runs on its own schedule; should be on demand"); return; }
      if (!enabled && wantEnabled === "enabled") { console.log("invalid disabled"); return; }
      // Without a declaration key openclaw cannot match this job to update it,
      // so the next installer run would mint a duplicate instead of converging.
      if (!job.declarationKey) { console.log("invalid no declaration key"); return; }
      if (kind === "command") { console.log("ok"); return; }
      const granted = Array.isArray(job.payload?.toolsAllow) ? job.payload.toolsAllow : [];
      const missing = tools.split(",").filter((t) => !granted.includes(t));
      if (missing.length > 0) { console.log(`invalid tools grant missing: ${missing.join(",")}`); return; }
      console.log("ok");
    });
  ' "$name" "$tools" "$want_enabled" "$kind"
}

# `openclaw cron rm` takes a job id POSITIONALLY. There is no --name option on
# it — only `cron add` has one — and the gateway rejects a non-id with
# "id not found". An earlier version of this script ran
# `openclaw cron delete --name "$name"`, which has never worked on any release;
# the `2>/dev/null` on it hid the failure. Resolve the name to ids first.
#
# Emits every id, not the first: job names are not unique, and duplicates are
# precisely what the delete paths are here to clean up.
cron_ids_for_name() {
  local name="$1"
  echo "$CRON_LIST" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => raw += d);
    process.stdin.on("end", () => {
      let parsed; try { parsed = JSON.parse(raw); } catch { return; }
      const jobs = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
      for (const j of jobs) {
        if (j?.name === process.argv[1] && typeof j?.id === "string" && j.id) console.log(j.id);
      }
    });
  ' "$name"
}

# An existing job's pinned model, if it has one. Read ONLY so a replacement can
# TELL the operator what it dropped — the suite never sets a model itself and has
# no basis for an opinion about anyone's model preferences. Replacing a job
# necessarily loses the pin (cron edit cannot add a declaration key, so
# delete-and-recreate is the only migration), and losing it silently would move
# the job back onto the agent default without the operator ever being asked.
cron_model_for_name() {
  local name="$1"
  echo "$CRON_LIST" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => raw += d);
    process.stdin.on("end", () => {
      let parsed; try { parsed = JSON.parse(raw); } catch { return; }
      const jobs = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
      const job = jobs.find((j) => j?.name === process.argv[1]);
      const model = job?.payload?.model;
      if (typeof model === "string" && model) console.log(model);
    });
  ' "$name"
}

# Deletes every job carrying $1. Returns non-zero if any delete failed.
delete_cron_by_name() {
  local name="$1" ids rc=0
  ids=$(cron_ids_for_name "$name")
  if [[ -z "$ids" ]]; then
    warn "No cron job named '$name' found to delete."
    return 1
  fi
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    openclaw cron rm "$id" >/dev/null 2>&1 || { warn "Could not delete cron job $id ($name)."; rc=1; }
  done <<< "$ids"
  return $rc
}

declare -A CRON_BASE_NAMES=(
  [thinking]="sapience-thinking"
  [routing]="sapience-routing"
  [goals]="sapience-goals-check"
  [delivery]="sapience-delivery"
  # Command payload, not an agent turn. Deliberately NOT named
  # "sapience-delivery-poll": multi-agent installs append "-<agent>" to every
  # base name and the doctor matches by "<base>-" prefix, so a name under the
  # delivery prefix would be indistinguishable from "sapience-delivery-<agent>".
  [pollDelivery]="sapience-poll-delivery"
)

# Stable identity for each job, independent of its name. `cron add
# --declaration-key` turns creation into an upsert: openclaw matches an existing
# job carrying the same key and updates it in place. Without this, every
# installer run minted a NEW job — one production install accumulated two rows
# each for three jobs, created eight days apart — and the rename that dropped
# the old "-pass" suffix orphaned that whole generation instead of migrating it.
# The "heartbeat:", "heartbeat-task:" and "skill-collection-review:" namespaces
# belong to the gateway; "sapience:" is ours. Multi-agent installs suffix the
# key with ":<agent>" so each agent's copy stays a distinct declaration rather
# than an ambiguous match (openclaw rejects an ambiguous key outright).
# Keep in sync with SUITE_CRONS in sapience/src/doctor/inventory.ts.
declare -A CRON_DECL_KEYS=(
  [thinking]="sapience:thinking"
  [routing]="sapience:routing"
  [goals]="sapience:goals-check"
  [delivery]="sapience:delivery"
  [pollDelivery]="sapience:poll-delivery"
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

# Announce's default "last" target resolves from the MAIN session's delivery
# context. On installs where DMs are scoped to per-peer sessions
# (session.dmScope per-channel-peer), the main session never gains a route and
# announce fails closed. Set these to pin the delivery cron to an explicit
# destination, e.g. SAPIENCE_DELIVERY_CHANNEL=telegram SAPIENCE_DELIVERY_TO=<chatId>.
#
# Pinning also buys silence. With an explicit target the delivery job sends
# through the `message` tool and carries NO announce route, so a run that ends
# without assistant text delivers nothing at all. With announce, OpenClaw 2026.8+
# substitutes a placeholder sentence for an empty post-tool turn and the announce
# route publishes it — the defect that put ninety-six messages a day into one
# operator's chat. Unpinned installs keep announce because its "last active
# channel" resolution is the only route they have.
SAPIENCE_DELIVERY_CHANNEL="${SAPIENCE_DELIVERY_CHANNEL:-}"
SAPIENCE_DELIVERY_TO="${SAPIENCE_DELIVERY_TO:-}"
DELIVERY_PINNED=false
[[ -n "$SAPIENCE_DELIVERY_TO" ]] && DELIVERY_PINNED=true

# The delivery cron is the only one whose final reply must reach the user's
# chat: cron announce delivery is the channel path stock openclaw grants
# globally-installed plugins (main-session injection is voided by the gateway's
# registration guard — openclaw PR #111131).
delivery_flag() {
  local key="$1"
  if [[ "$key" == "delivery" && "$DELIVERY_PINNED" == "false" ]]; then
    echo "--announce"
  else
    echo "--no-deliver"
  fi
}

delivery_target_args() {
  local key="$1"
  if [[ "$key" == "delivery" && "$DELIVERY_PINNED" == "true" ]]; then
    echo "--channel ${SAPIENCE_DELIVERY_CHANNEL:-telegram} --to $SAPIENCE_DELIVERY_TO"
  fi
}

# The delivery job runs ON DEMAND, not on a schedule. Its queue is empty on the
# great majority of cycles, so a scheduled copy spent ~90 of its 96 daily model
# turns discovering there was nothing to do — and on OpenClaw 2026.8+ each of
# those empty turns delivered a placeholder sentence to the operator. The
# sapience-poll-delivery job reads the queue in plugin code (a command payload:
# no model, no bootstrap context, no delivery route) and starts this job only
# when there is something to send.
#
# Command payloads rather than openclaw's --trigger-script gate: trigger scripts
# require cron.triggers.enabled, which grants headless exec with the owning
# agent's full tool policy. Gating a queue read is not worth turning that on.
cron_extra_args() {
  local key="$1"
  case "$key" in
    delivery) echo "--disabled" ;;
    *) echo "" ;;
  esac
}

declare -A CRON_MESSAGES=(
  [thinking]="You are running a scheduled thinking pass. Call get_thinking_context() to receive your context and instructions. If it returns {status:skip}, reply with NO_REPLY and stop. Otherwise review the context carefully, then call record_thinking_output() with your proposals. Do not produce any other output. If the tool is not available, reply NO_REPLY and stop."
  [routing]="You are the sapience routing agent. Call process_proposals() to route new thinking pass proposals. Reply NO_REPLY after the tool call. If the tool is not available, reply NO_REPLY and stop."
  [goals]="You are the goals tracking agent. Call check_goals() to process new goals and deliver weekly status updates. Reply NO_REPLY after the tool call. If the tool is not available, reply NO_REPLY and stop."
  [delivery]="You are the sapience delivery agent. Call get_pending_deliveries() to fetch notifications that could not reach the user through the normal path. If it returns NOTHING_PENDING, reply NO_REPLY and stop. Otherwise compose ONE concise message to the user covering every pending item — lead with the most important, keep it brief, and write as the assistant speaking directly to the user; your final reply is delivered to their chat. If the tool is not available, reply NO_REPLY and stop."
)

# With a pinned target the job sends through the `message` tool and has no
# announce route, so an empty turn or a malformed tool call is silent. Keep in
# sync with deliveryToolMessage() in sapience/src/doctor/cron-args.ts.
if [[ "$DELIVERY_PINNED" == "true" ]]; then
  CRON_TOOLS[delivery]="get_pending_deliveries,message"
  CRON_MESSAGES[delivery]="You are the sapience delivery agent. Call get_pending_deliveries() to fetch notifications that could not reach the user through the normal path. If it returns NOTHING_PENDING, reply NO_REPLY and stop. Otherwise compose ONE concise message to the user covering every pending item — lead with the most important, keep it brief, and write as the assistant speaking directly to the user. Send it with the message tool to channel \"${SAPIENCE_DELIVERY_CHANNEL:-telegram}\", target \"${SAPIENCE_DELIVERY_TO}\". After the message tool reports success, reply NO_REPLY and stop. If the tool is not available, reply NO_REPLY and stop."
fi

# The poll job runs as ARGV with an absolute path, never as a shell string.
# The Gateway executes a command payload via `sh -lc`, and on Debian/Ubuntu sh
# is dash, whose login shell reads /etc/profile but not ~/.bashrc — where an
# npm-global bin directory usually lands. Registering "openclaw sapience
# deliver-check" produced `sh: 1: openclaw: not found`, exit 127, on every run
# until the job auto-disabled itself after ten consecutive failures, while the
# very same command worked by hand in the operator's shell.
OPENCLAW_BIN=$(command -v openclaw || true)
if [[ "$OPENCLAW_BIN" != /* ]]; then
  warn "Could not resolve an absolute path to 'openclaw' (got: ${OPENCLAW_BIN:-nothing})."
  warn "The delivery poll job needs one — the gateway's shell does not share your PATH."
  OPENCLAW_BIN="openclaw"
fi
POLL_DELIVERY_ARGV=$(node -e 'process.stdout.write(JSON.stringify([process.argv[1], "sapience", "deliver-check"]))' "$OPENCLAW_BIN")

cron_name() {
  local base="$1" agent="$2"
  if [[ "$MULTI_AGENT" == "true" ]]; then echo "${base}-${agent}"; else echo "$base"; fi
}

CRON_SCHEDULE="*/15 * * * *"

# Which jobs run on their own schedule, and which are command payloads.
cron_want_enabled() { [[ "$1" == "delivery" ]] && echo "disabled" || echo "enabled"; }
cron_kind()         { [[ "$1" == "pollDelivery" ]] && echo "command" || echo "agent"; }

# Superseded jobs from the naming generation that used a "-pass" suffix. That
# generation shipped `delivery: { mode: "announce" }` alongside prompts asking
# the model to reply with the literal string "SILENT_REPLY_TOKEN" — which the
# runtime does not recognize — so on OpenClaw 2026.8+ every one of their runs
# delivers text to the operator's chat. The rename was never a migration, so an
# install that upgraded across it runs both generations at once.
sweep_legacy_pass_crons() {
  local legacy
  legacy=$(echo "$CRON_LIST" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => raw += d);
    process.stdin.on("end", () => {
      let parsed; try { parsed = JSON.parse(raw); } catch { return; }
      const jobs = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
      const bases = ["sapience-thinking", "sapience-routing", "sapience-goals-check", "sapience-delivery"];
      for (const j of jobs) {
        const n = typeof j?.name === "string" ? j.name : "";
        if (bases.some((b) => n === `${b}-pass` || n.startsWith(`${b}-pass-`))) console.log(n);
      }
    });
  ')
  [[ -z "$legacy" ]] && return 0

  echo ""
  warn "Superseded jobs from an older sapience install are still registered:"
  while IFS= read -r n; do [[ -n "$n" ]] && echo "    $n"; done <<< "$legacy"
  info "These predate the current job names and were never migrated. They announce on"
  info "every run on OpenClaw 2026.8+, and the current jobs already do their work."
  if confirm "Delete them?" y; then
    while IFS= read -r n; do
      [[ -z "$n" ]] && continue
      delete_cron_by_name "$n" || warn "Delete '$n' by hand: openclaw cron rm <id>"
    done <<< "$legacy"
    ok "Superseded jobs removed"
  fi
}

sweep_legacy_pass_crons

# CRONS_TO_ADD stores "key:agent:replace" triples, where replace is "yes" when a
# pre-existing job has to be deleted before the new one is registered.
CRONS_TO_ADD=()

for agent in "${CRON_AGENTS[@]}"; do
  for key in thinking routing goals delivery pollDelivery; do
    name=$(cron_name "${CRON_BASE_NAMES[$key]}" "$agent")
    state=$(cron_state "$name" "${CRON_TOOLS[$key]:-}" "$(cron_want_enabled "$key")" "$(cron_kind "$key")")
    case "$state" in
      ok)
        ok "Cron job '$name' is registered and correctly configured"
        ;;
      missing)
        warn "Cron job '$name' is NOT registered"
        CRONS_TO_ADD+=("${key}:${agent}:no")
        ;;
      "invalid no declaration key")
        # The one case that still needs delete-then-recreate. openclaw's upsert
        # matches on the declaration key alone, so a job registered before the
        # suite adopted keys carries none and CANNOT be matched — `cron add`
        # would mint a second job beside it and leave the original running on
        # its old schedule and delivery route. For the delivery job that means
        # the announce-mode copy keeps announcing every fifteen minutes, so
        # re-running this installer without the delete would make the noise
        # worse rather than better.
        warn "Cron job '$name' predates declaration keys — it must be replaced, not updated"
        CRONS_TO_ADD+=("${key}:${agent}:yes")
        ;;
      invalid*)
        # Everything else is a genuine upsert: the job already carries the right
        # key, so re-running `cron add` updates it in place.
        warn "Cron job '$name' needs updating (${state#invalid })"
        CRONS_TO_ADD+=("${key}:${agent}:no")
        ;;
    esac
  done
done

# The declaration key is what makes re-registration an upsert. Multi-agent
# installs qualify it per agent so each copy is its own declaration — two jobs
# sharing a key inside one caller scope make the match ambiguous, and openclaw
# rejects that outright rather than guessing.
cron_decl_key() {
  local key="$1" agent="$2"
  if [[ "$MULTI_AGENT" == "true" ]]; then echo "${CRON_DECL_KEYS[$key]}:${agent}"; else echo "${CRON_DECL_KEYS[$key]}"; fi
}

# --light-context skips workspace bootstrap file injection. These jobs get their
# instructions from their prompt and their data from their tool; the operator's
# agent instructions, long-term memory file and persona documents contributed
# nothing but ~15k input tokens per run.
register_cron() {
  local key="$1" agent="$2" name="$3"

  if [[ "$key" == "pollDelivery" ]]; then
    openclaw cron add \
      --name "$name" \
      --declaration-key "$(cron_decl_key "$key" "$agent")" \
      --cron "$CRON_SCHEDULE" \
      --session isolated \
      --agent "$agent" \
      --no-deliver \
      --command-argv "$POLL_DELIVERY_ARGV" \
      --timeout-seconds 120
    return
  fi

  # shellcheck disable=SC2046 — delivery_target_args and cron_extra_args split intentionally
  openclaw cron add \
    --name "$name" \
    --declaration-key "$(cron_decl_key "$key" "$agent")" \
    --cron "$CRON_SCHEDULE" \
    --session isolated \
    --agent "$agent" \
    $(cron_extra_args "$key") \
    "$(delivery_flag "$key")" \
    $(delivery_target_args "$key") \
    --light-context \
    --tools "${CRON_TOOLS[$key]}" \
    --message "${CRON_MESSAGES[$key]}" \
    --timeout-seconds 120
}

print_cron_command() {
  local key="$1" agent="$2" name="$3"
  echo ""
  echo "  openclaw cron add \\"
  echo "    --name \"$name\" \\"
  echo "    --declaration-key \"$(cron_decl_key "$key" "$agent")\" \\"
  echo "    --cron \"$CRON_SCHEDULE\" \\"
  echo "    --session isolated \\"
  echo "    --agent \"$agent\" \\"
  if [[ "$key" == "pollDelivery" ]]; then
    echo "    --no-deliver \\"
    echo "    --command-argv '$POLL_DELIVERY_ARGV' \\"
    echo "    --timeout-seconds 120"
    return
  fi
  [[ -n "$(cron_extra_args "$key")" ]] && echo "    $(cron_extra_args "$key") \\"
  echo "    $(delivery_flag "$key") \\"
  [[ -n "$(delivery_target_args "$key")" ]] && echo "    $(delivery_target_args "$key") \\"
  echo "    --light-context \\"
  echo "    --tools \"${CRON_TOOLS[$key]}\" \\"
  echo "    --message \"${CRON_MESSAGES[$key]}\" \\"
  echo "    --timeout-seconds 120"
}

if [[ ${#CRONS_TO_ADD[@]} -gt 0 ]]; then
  echo ""
  warn "Cron jobs to register or update: $(for item in "${CRONS_TO_ADD[@]}"; do IFS=: read -r key agent _ <<< "$item"; echo -n "$(cron_name "${CRON_BASE_NAMES[$key]}" "$agent") "; done)"
  if confirm "Register them now?"; then
    for item in "${CRONS_TO_ADD[@]}"; do
      IFS=: read -r key agent replace <<< "$item"
      name=$(cron_name "${CRON_BASE_NAMES[$key]}" "$agent")
      if [[ "$replace" == "yes" ]]; then
        echo "  Removing the pre-declaration-key '$name' so it isn't left running beside the new one..."
        delete_cron_by_name "$name" \
          || warn "Could not delete '$name' automatically — delete it by hand (openclaw cron rm <id>), or you will end up with two copies."
      fi
      pinned_model=""
      if [[ "$replace" == "yes" ]]; then pinned_model=$(cron_model_for_name "$name"); fi
      echo "  Registering $name (agent: $agent)..."
      register_cron "$key" "$agent" "$name"
      ok "Registered $name"
      if [[ -n "$pinned_model" ]]; then
        warn "  '$name' pinned the model $pinned_model; the new registration does not."
        info "  Sapience never sets a model. To keep that pin:"
        info "    openclaw cron list --all --json   # find the new id"
        info "    openclaw cron edit <id> --model $pinned_model"
      fi
    done
  else
    info "Skipping cron registration. You can register manually — see README for cron commands."
    echo ""
    info "To register manually:"
    for item in "${CRONS_TO_ADD[@]}"; do
      IFS=: read -r key agent replace <<< "$item"
      name=$(cron_name "${CRON_BASE_NAMES[$key]}" "$agent")
      if [[ "$replace" == "yes" ]]; then
        echo ""
        echo "  # '$name' predates declaration keys and cannot be updated in place — delete it first,"
        echo "  # or the command below adds a second copy and leaves the original running."
        echo "  openclaw cron list --all --json   # find the id for '$name'"
        echo "  openclaw cron rm <id>"
      fi
      print_cron_command "$key" "$agent" "$name"
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

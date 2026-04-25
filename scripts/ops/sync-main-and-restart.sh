#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_repo_root="$(cd "${script_dir}/../.." && pwd)"

repo_root="${MOTTBOT_AUTO_SYNC_REPO:-$default_repo_root}"
remote="${MOTTBOT_AUTO_SYNC_REMOTE:-origin}"
branch="${MOTTBOT_AUTO_SYNC_BRANCH:-main}"
lock_dir="${MOTTBOT_AUTO_SYNC_LOCK_DIR:-$repo_root/data/auto-sync.lock}"
dry_run="${MOTTBOT_AUTO_SYNC_DRY_RUN:-0}"
node_path="${MOTTBOT_SERVICE_NODE_PATH:-/Users/mottbot/.local/share/fnm/node-versions/v24.13.1/installation/bin/node}"
service_label="${MOTTBOT_AUTO_SYNC_SERVICE_LABEL:-}"
config_path="${MOTTBOT_CONFIG_PATH:-}"

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

run() {
  log "+ $*"
  if [[ "$dry_run" == "1" ]]; then
    return 0
  fi
  "$@"
}

pnpm_run() {
  run corepack pnpm run "$@"
}

pnpm_exec() {
  run corepack pnpm "$@"
}

mkdir -p "$(dirname "$lock_dir")"
if ! mkdir "$lock_dir" 2>/dev/null; then
  log "Another auto-sync run is already active at $lock_dir; exiting."
  exit 0
fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

cd "$repo_root"
git rev-parse --is-inside-work-tree >/dev/null

log "Checking ${remote}/${branch} from $repo_root."
run git fetch --prune "$remote" "$branch"

remote_ref="${remote}/${branch}"
local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse "$remote_ref")"

if [[ "$local_head" == "$remote_head" ]]; then
  log "Already synced at ${local_head}."
  exit 0
fi

if [[ -n "$(git status --porcelain)" ]]; then
  fail "Working tree is dirty; refusing to auto-sync."
fi

if ! git merge-base --is-ancestor HEAD "$remote_ref"; then
  fail "Local HEAD is not an ancestor of $remote_ref; refusing non-fast-forward sync."
fi

if [[ "$dry_run" == "1" ]]; then
  log "Dry run: would fast-forward ${local_head} -> ${remote_head}, verify, and restart service."
  exit 0
fi

run git merge --ff-only "$remote_ref"
run corepack pnpm install --frozen-lockfile
pnpm_run build
pnpm_run health

if [[ -x "$node_path" ]]; then
  export MOTTBOT_SERVICE_NODE_PATH="$node_path"
  export PATH="$(dirname "$node_path"):$PATH"
else
  log "Configured Node path is not executable: $node_path"
fi

restart_args=(restart)
restart_extra=()
status_args=(service status)
if [[ -n "$service_label" ]]; then
  restart_extra+=(--label "$service_label")
  status_args+=(--label "$service_label")
fi
if [[ -n "$config_path" ]]; then
  restart_extra+=(--config-path "$config_path")
  status_args+=(--config-path "$config_path")
fi
if [[ "${#restart_extra[@]}" -gt 0 ]]; then
  restart_args+=(-- "${restart_extra[@]}")
fi

pnpm_run "${restart_args[@]}"
pnpm_exec "${status_args[@]}"
log "Auto-sync completed at $(git rev-parse --short HEAD)."

#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

label="${MOTTBOT_AUTO_SYNC_LABEL:-ai.mottbot.sync-main}"
interval_seconds="${MOTTBOT_AUTO_SYNC_INTERVAL_SECONDS:-300}"
node_path="${MOTTBOT_SERVICE_NODE_PATH:-/Users/mottbot/.local/share/fnm/node-versions/v24.13.1/installation/bin/node}"
sync_remote="${MOTTBOT_AUTO_SYNC_REMOTE:-origin}"
sync_branch="${MOTTBOT_AUTO_SYNC_BRANCH:-main}"
sync_service_label="${MOTTBOT_AUTO_SYNC_SERVICE_LABEL:-}"
config_path="${MOTTBOT_CONFIG_PATH:-}"
launch_agents_dir="$HOME/Library/LaunchAgents"
log_dir="$HOME/Library/Logs/mottbot"
plist_path="$launch_agents_dir/$label.plist"
stdout_path="$log_dir/sync-main.out.log"
stderr_path="$log_dir/sync-main.err.log"
target="gui/$(id -u)/$label"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

write_plist() {
  mkdir -p "$launch_agents_dir" "$log_dir"
  cat >"$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$label")</string>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$repo_root")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$repo_root/scripts/ops/sync-main-and-restart.sh")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MOTTBOT_AUTO_SYNC_REPO</key>
    <string>$(xml_escape "$repo_root")</string>
    <key>MOTTBOT_AUTO_SYNC_REMOTE</key>
    <string>$(xml_escape "$sync_remote")</string>
    <key>MOTTBOT_AUTO_SYNC_BRANCH</key>
    <string>$(xml_escape "$sync_branch")</string>
    <key>MOTTBOT_AUTO_SYNC_SERVICE_LABEL</key>
    <string>$(xml_escape "$sync_service_label")</string>
    <key>MOTTBOT_CONFIG_PATH</key>
    <string>$(xml_escape "$config_path")</string>
    <key>MOTTBOT_SERVICE_NODE_PATH</key>
    <string>$(xml_escape "$node_path")</string>
    <key>PATH</key>
    <string>$(xml_escape "$(dirname "$node_path"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>$interval_seconds</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$stdout_path")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$stderr_path")</string>
</dict>
</plist>
EOF
  chmod 0644 "$plist_path"
}

install_agent() {
  write_plist
  launchctl bootout "gui/$(id -u)" "$plist_path" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  launchctl enable "$target"
  printf 'Installed %s\nPlist: %s\nLogs: %s\n' "$label" "$plist_path" "$log_dir"
}

uninstall_agent() {
  launchctl bootout "gui/$(id -u)" "$plist_path" >/dev/null 2>&1 || true
  rm -f "$plist_path"
  printf 'Uninstalled %s\nRemoved: %s\n' "$label" "$plist_path"
}

status_agent() {
  if [[ -f "$plist_path" ]]; then
    printf 'Plist: %s\n' "$plist_path"
  else
    printf 'Plist missing: %s\n' "$plist_path"
  fi
  launchctl print "$target"
}

command="${1:-install}"
case "$command" in
  install)
    install_agent
    ;;
  uninstall)
    uninstall_agent
    ;;
  status)
    status_agent
    ;;
  *)
    printf 'Usage: %s [install|uninstall|status]\n' "$0" >&2
    exit 1
    ;;
esac

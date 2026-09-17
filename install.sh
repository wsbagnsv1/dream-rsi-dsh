#!/usr/bin/env bash
# Dream-RSI DSH installer (POSIX).
# Copies the agent preset into your DSH home and rewrites the plugin entry
# to an absolute path so the preset mounts from anywhere.
#
# Usage:
#   pnpm install && pnpm build     # in this repo root
#   ./install.sh                   # copy-install
#   ./install.sh --print-overlay   # print a roots-discovery overlay instead
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENTRY="$REPO_ROOT/dist/index.js"
if [ ! -f "$ENTRY" ]; then
  if [ -f "$REPO_ROOT/src/index.ts" ]; then
    ENTRY="$REPO_ROOT/src/index.ts"
    echo "NOTE: dist/index.js not found - falling back to src/index.ts (works only for run-from-source DSH via tsx)."
    echo "      Prefer 'pnpm install && pnpm build' first."
  else
    echo "ERROR: neither dist/index.js nor src/index.ts found. Run 'pnpm install && pnpm build' first." >&2
    exit 1
  fi
fi
echo "Plugin entry: $ENTRY"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PRESET_TARGET="$DSH_HOME/.agent-presets/dream-rsi"

if [[ "${1:-}" == "--print-overlay" ]]; then
  PRESET_DIR_POSIX="$REPO_ROOT/preset"
  cat <<EOF

Roots-discovery mode: add this row to your Web profile patch or a --patch overlay
(it only adds a preset discovery root; nothing is mounted into the baseline):

- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard   # restate YOUR deployment default; patch layers replace whole configs
        roots:
          - path: '$PRESET_DIR_POSIX'
            trust: system

In roots mode no copy is made; the preset row resolves '../dist/index.js'
relative to this repo's preset/ directory, so keep dist/ built.
EOF
  exit 0
fi

mkdir -p "$(dirname "$PRESET_TARGET")"
rm -rf "$PRESET_TARGET"
cp -r "$REPO_ROOT/preset/dream-rsi" "$PRESET_TARGET"

COMPOSITION="$PRESET_TARGET/agent.cordis.yml"
# The shipped row is relative to the preset dir; a copy has no dist beside it,
# so rewrite to the absolute entry path.
ENTRY_ABS="$(cd "$(dirname "$ENTRY")" && pwd)/$(basename "$ENTRY")"
sed -i.bak "s|'\.\./\.\./dist/index\.js'|'$ENTRY_ABS'|" "$COMPOSITION"
rm -f "$COMPOSITION.bak"

echo
echo "Installed: $PRESET_TARGET"
echo "  entry:    $ENTRY_ABS"
echo
echo 'Next: (re)start DSH Web, open the new-session preset picker, choose "Dream-RSI".'
echo 'Only sessions started on that preset get the seven dreamrsi_* tools; the baseline stays clean.'
echo 'Note: re-run this installer if you move this repository or after pulling code changes'
echo '(preset copies are snapshots).'

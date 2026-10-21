#!/usr/bin/env bash
set -euo pipefail

SKILL_NAME="t3-mission-mode"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL_DIR="${HOME}/.agents/skills/${SKILL_NAME}"

echo "Installing ${SKILL_NAME}..."

mkdir -p "${HOME}/.agents/skills"

if [ "${SCRIPT_DIR}" != "${CANONICAL_DIR}" ]; then
  rm -rf "${CANONICAL_DIR}"
  cp -R "${SCRIPT_DIR}" "${CANONICAL_DIR}"
  rm -rf "${CANONICAL_DIR}/.git"
  echo "  -> Installed canonical skill to ${CANONICAL_DIR}"
else
  echo "  -> Already running from canonical skill path ${CANONICAL_DIR}"
fi

# Ensure ~/.agent/skills -> ~/.agents/skills compatibility symlink
mkdir -p "${HOME}/.agent"
if [ ! -e "${HOME}/.agent/skills" ]; then
  ln -s "${HOME}/.agents/skills" "${HOME}/.agent/skills"
  echo "  -> Linked ${HOME}/.agent/skills -> ${HOME}/.agents/skills"
fi

# Symlink into detected agent skill directories
TARGET_DIRS=(
  "${HOME}/.codex/skills"
  "${HOME}/.claude/skills"
  "${HOME}/.gemini/antigravity-cli/skills"
  "${HOME}/.gemini/skills"
  "${HOME}/.gemini/config/skills"
  "${HOME}/.factory/skills"
  "${HOME}/.pi/agent/skills"
  "${HOME}/.config/opencode/skills"
  "${HOME}/.cursor/skills"
)

for dir in "${TARGET_DIRS[@]}"; do
  parent_dir="$(dirname "${dir}")"
  if [ -d "${dir}" ] || [ -d "${parent_dir}" ]; then
    mkdir -p "${dir}"
    ln -sfn "${CANONICAL_DIR}" "${dir}/${SKILL_NAME}"
    echo "  -> Linked ${dir}/${SKILL_NAME} -> ${CANONICAL_DIR}"
  fi
done

echo ""
echo "✅ ${SKILL_NAME} installed successfully!"
echo "   Start a mission in T3 Code with: /mission <your request>"
echo "   Resume a paused mission with:    [resume the mission]"

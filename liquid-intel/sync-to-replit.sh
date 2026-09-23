#!/usr/bin/env bash
# Apply the LIQ-INTEL upgrade to a Replit workspace, with an automatic backup.
#
# Run from the root of the "Liquid Intel" Repl (the folder with package.json):
#   curl -fsSL https://raw.githubusercontent.com/lowryat/Lowryat.github.io/claude/replit-finance-api-pipeline-45hfde/liquid-intel/sync-to-replit.sh | bash
# or, after copying this file into the Repl:
#   bash sync-to-replit.sh            # apply
#   bash sync-to-replit.sh --verify   # apply, then typecheck and run the fast tests
#   bash sync-to-replit.sh --force    # apply even if files changed since the upgrade was prepared
#
# Private repository? Set GITHUB_TOKEN in Replit Secrets first.
# Undo: the script prints a restore command; it puts every replaced file back
# and deletes every file it added.
set -euo pipefail

OWNER="lowryat"
REPO="Lowryat.github.io"
BRANCH="${LIQ_BRANCH:-claude/replit-finance-api-pipeline-45hfde}"
VERIFY=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --verify) VERIFY=1 ;;
    --force) FORCE=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [[ ! -f package.json || ! -f server/routes.ts || ! -d client/src ]]; then
  echo "Run this from the root of the Liquid Intel Repl (package.json, server/, client/ must exist)." >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP=".liq-backup/${STAMP}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Downloading ${OWNER}/${REPO}@${BRANCH} ..."
AUTH=()
[[ -n "${GITHUB_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
curl -fsSL ${AUTH[@]+"${AUTH[@]}"} -o "$WORK/src.tar.gz" \
  "https://codeload.github.com/${OWNER}/${REPO}/tar.gz/refs/heads/${BRANCH}"
tar -xzf "$WORK/src.tar.gz" -C "$WORK"
OVERLAY="$(find "$WORK" -maxdepth 3 -type d -path '*/liquid-intel/overlay' | head -n1)"
if [[ -z "$OVERLAY" ]]; then
  echo "The download does not contain liquid-intel/overlay." >&2
  exit 1
fi

# Refuse to overwrite files that changed after this upgrade was prepared
# (for example, edits made by the Replit Agent), unless --force is given.
MANIFEST="$(dirname "$OVERLAY")/base-manifest.json"
if [[ -f "$MANIFEST" ]]; then
  CHANGED="$(node -e '
    const fs = require("fs"), crypto = require("crypto");
    const { files } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const [rel, hash] of Object.entries(files)) {
      if (!fs.existsSync(rel)) continue;
      const text = fs.readFileSync(rel, "utf8").replace(/\r\n/g, "\n").replace(/\s+$/, "");
      if (crypto.createHash("sha256").update(text).digest("hex") !== hash) console.log(rel);
    }' "$MANIFEST")"
  if [[ -n "$CHANGED" ]]; then
    echo "These files changed in your Repl after the upgrade was prepared:"
    echo "$CHANGED" | sed 's/^/  /'
    if [[ $FORCE -eq 0 ]]; then
      echo "Nothing was changed. Applying would replace your newer edits in these files."
      echo "Review them, then re-run with --force to apply anyway (a full backup is still made)."
      exit 2
    fi
    echo "--force given: continuing. Your versions are saved in the backup."
  fi
fi

mkdir -p "$BACKUP"
: > "$BACKUP/added-files.txt"
replaced=0
added=0
while IFS= read -r -d '' file; do
  rel="${file#"$OVERLAY"/}"
  if [[ -e "$rel" ]]; then
    mkdir -p "$BACKUP/files/$(dirname "$rel")"
    cp -p "$rel" "$BACKUP/files/$rel"
    replaced=$((replaced + 1))
  else
    echo "$rel" >> "$BACKUP/added-files.txt"
    added=$((added + 1))
  fi
  mkdir -p "$(dirname "$rel")"
  cp "$file" "$rel"
done < <(find "$OVERLAY" -type f -print0)

cat > "$BACKUP/restore.sh" <<EOF
#!/usr/bin/env bash
# Restores the workspace to its state before the ${STAMP} upgrade.
set -euo pipefail
cd "\$(dirname "\$0")/../.."
if [[ -d "${BACKUP}/files" ]]; then cp -rp "${BACKUP}/files/." . ; fi
while IFS= read -r rel; do
  [[ -n "\$rel" ]] || continue
  rm -f "\$rel"
  # Remove folders the upgrade created, if they are now empty.
  dir="\$(dirname "\$rel")"
  [[ "\$dir" != "." ]] && rmdir -p "\$dir" 2>/dev/null || true
done < "${BACKUP}/added-files.txt"
echo "Restored the files replaced on ${STAMP} and removed the files it added. Restart the Repl."
EOF
chmod +x "$BACKUP/restore.sh"
if ! grep -qx '.liq-backup/' .gitignore 2>/dev/null; then
  if [[ -f .gitignore ]]; then
    mkdir -p "$BACKUP/files" && cp -p .gitignore "$BACKUP/files/.gitignore"
  else
    echo ".gitignore" >> "$BACKUP/added-files.txt"
  fi
  echo '.liq-backup/' >> .gitignore
fi

echo
echo "Applied upgrade: ${replaced} files replaced, ${added} files added."
echo "Backup: ${BACKUP}"
echo "Undo at any time with:  bash ${BACKUP}/restore.sh"

if [[ $VERIFY -eq 1 ]]; then
  echo
  echo "Typechecking ..."
  npx tsc --noEmit
  echo "Running fast tests (no database needed) ..."
  # Database tests are left out on purpose: they create temporary databases on
  # whatever DATABASE_URL points at, which in a Repl is the production database.
  npx tsx --test server/resilience.test.ts server/http-client.test.ts server/sms.test.ts server/daily-history.test.ts shared/quant/quant.test.ts
fi

cat <<'EOF'

Next steps
  1. Restart the Repl (Stop, then Run) so the new server code loads.
  2. Open the app, then the HEALTH tab. Every provider should turn green within about two minutes.
  3. Optional secrets (Tools > Secrets):
       NTFY_TOPIC                   free push alerts; subscribe to the same topic in the ntfy app
       TWILIO_MESSAGING_SERVICE_SID recommended for US numbers (A2P 10DLC)
       COINGECKO_API_KEY            free demo key; faster history loading
       SESSION_SECRET               keeps alert ownership stable across restarts
       PUBLIC_APP_URL               adds an app link to alert texts
  4. ALERTS tab > "Check SMS setup" explains any Twilio problem in plain language.
  5. Republish the deployment when you are happy with the preview.
EOF

#!/usr/bin/env bash
# Re-applies the pi-chhound pi-tui patches to the running pi installation.
# pi updates overwrite node_modules, so re-run this after updating pi.
# Usage: bash scripts/patch-pi-tui.sh
set -euo pipefail

PI_TUI_DIR="${PI_TUI_DIR:-/usr/local/share/nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui}"
AUTO="$PI_TUI_DIR/dist/autocomplete.js"
EDITOR="$PI_TUI_DIR/dist/components/editor.js"

if [[ ! -f "$AUTO" || ! -f "$EDITOR" ]]; then
	echo "pi-tui not found at $PI_TUI_DIR — set PI_TUI_DIR to the pi-tui package dir." >&2
	exit 1
fi

python3 - "$AUTO" <<'PY'
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
marker = "// No or empty argument completions: fall through to file completion."
if marker in src:
    print(f"autocomplete.js: already patched ({path})")
    sys.exit(0)

old = """            if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
                return null;
            }
            const argumentSuggestions = await command.getArgumentCompletions(argumentText);
            if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
                return null;
            }
            return {
                items: argumentSuggestions,
                prefix: argumentText,
            };"""
new = """            if (command && "getArgumentCompletions" in command && command.getArgumentCompletions) {
                const argumentSuggestions = await command.getArgumentCompletions(argumentText);
                if (Array.isArray(argumentSuggestions) && argumentSuggestions.length > 0) {
                    return {
                        items: argumentSuggestions,
                        prefix: argumentText,
                    };
                }
                // No or empty argument completions: fall through to file completion.
            }"""
if old not in src:
    print(f"autocomplete.js: expected snippet not found — pi-tui version may have changed ({path})", file=sys.stderr)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(src.replace(old, new))
print(f"autocomplete.js: patched ({path})")
PY

python3 - "$EDITOR" <<'PY'
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
marker = "// pi-chhound patch: after accepting a command-name completion"
if marker in src:
    print(f"editor.js: already patched ({path})")
    sys.exit(0)

old = """                    this.cancelAutocomplete();
                    if (this.onChange)
                        this.onChange(this.getText());"""
new = """                    this.cancelAutocomplete();
                    // pi-chhound patch: after accepting a command-name completion
                    // ("…/cmd " with trailing space), immediately show argument
                    // completions (e.g. the directory picker) instead of nothing.
                    const appliedText = this.state.lines[this.state.cursorLine] ?? "";
                    if (/^\\/\\S+ $/.test(appliedText.slice(0, this.state.cursorCol))) {
                        this.tryTriggerAutocomplete(true);
                    }
                    if (this.onChange)
                        this.onChange(this.getText());"""
if old not in src:
    print(f"editor.js: expected snippet not found — pi-tui version may have changed ({path})", file=sys.stderr)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(src.replace(old, new, 1))
print(f"editor.js: patched ({path})")
PY

echo "OK — restart pi for the changes to take effect."

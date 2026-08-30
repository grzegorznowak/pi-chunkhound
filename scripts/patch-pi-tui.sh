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

V2_TAB = """                    this.cancelAutocomplete();
                    // pi-chhound patch: after accepting a command-name completion
                    // ("\u2026/cmd " with trailing space) or a directory item (\u2026/),
                    // immediately show the next level of completions.
                    const appliedText = this.state.lines[this.state.cursorLine] ?? "";
                    const appliedBeforeCursor = appliedText.slice(0, this.state.cursorCol);
                    if (/^\/\\S+ $/.test(appliedBeforeCursor) || appliedBeforeCursor.endsWith("/")) {
                        this.tryTriggerAutocomplete(true);
                    }
                    if (this.onChange)
                        this.onChange(this.getText());"""
V2_ENTER = """                    const appliedText = this.state.lines[this.state.cursorLine] ?? "";
                    const appliedBeforeCursor = appliedText.slice(0, this.state.cursorCol);
                    if (/^\/\\S+ $/.test(appliedBeforeCursor)) {
                        // pi-chhound patch: only command-name completions fall
                        // through to submit; path completions (incl. absolute)
                        // must not submit the prompt.
                        this.cancelAutocomplete();
                        // Fall through to submit
                    }
                    else {
                        this.cancelAutocomplete();
                        // pi-chhound patch: directory accept \u2192 show next level immediately.
                        if (appliedBeforeCursor.endsWith("/")) {
                            this.tryTriggerAutocomplete(true);
                        }
                        if (this.onChange)
                            this.onChange(this.getText());
                        return;
                    }"""
V2_MARKER = "// pi-chhound patch: after accepting a command-name completion"
if V2_MARKER in src:
    print(f"editor.js: already patched ({path})")
    sys.exit(0)

P_TAB = """                    this.cancelAutocomplete();
                    if (this.onChange)
                        this.onChange(this.getText());"""
P_ENTER = """                    if (this.autocompletePrefix.startsWith("/")) {
                        this.cancelAutocomplete();
                        // Fall through to submit
                    }
                    else {
                        this.cancelAutocomplete();
                        if (this.onChange)
                            this.onChange(this.getText());
                        return;
                    }"""
V1_TAB = """                    this.cancelAutocomplete();
                    // pi-chhound patch: after accepting a command-name completion
                    // ("\u2026/cmd " with trailing space), immediately show argument
                    // completions (e.g. the directory picker) instead of nothing.
                    const appliedText = this.state.lines[this.state.cursorLine] ?? "";
                    if (/^\/\\S+ $/.test(appliedText.slice(0, this.state.cursorCol))) {
                        this.tryTriggerAutocomplete(true);
                    }
                    if (this.onChange)
                        this.onChange(this.getText());"""

if V1_TAB in src and P_ENTER in src:
    src = src.replace(V1_TAB, V2_TAB).replace(P_ENTER, V2_ENTER)
elif P_TAB in src and P_ENTER in src:
    src = src.replace(P_TAB, V2_TAB).replace(P_ENTER, V2_ENTER)
else:
    print(f"editor.js: expected snippets not found — pi-tui version may have changed ({path})", file=sys.stderr)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(src)
print(f"editor.js: patched ({path})")
PY

python3 - "$EDITOR" <<'PY'
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
marker = "// pi-chhound patch: keys hint under the picker when in a slash-command context."
if marker in src:
    print(f"editor.js: keys hint already patched ({path})")
    sys.exit(0)

old = """        // Add autocomplete list if active
        if (this.autocompleteState && this.autocompleteList) {
            const autocompleteResult = this.autocompleteList.render(contentWidth);
            for (const line of autocompleteResult) {
                const lineWidth = visibleWidth(line);
                const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
                result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
            }
        }
        return result;"""
new = """        // Add autocomplete list if active
        if (this.autocompleteState && this.autocompleteList) {
            const autocompleteResult = this.autocompleteList.render(contentWidth);
            for (const line of autocompleteResult) {
                const lineWidth = visibleWidth(line);
                const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
                result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
            }
            // pi-chhound patch: keys hint under the picker when in a slash-command context.
            const hintLineBefore = (this.state.lines[this.state.cursorLine] ?? "").slice(0, this.state.cursorCol);
            if (hintLineBefore.trimStart().startsWith("/")) {
                const hint = this.borderColor("\u2191/\u2193 move \u00b7 TAB accept \u00b7 Esc close");
                const hintPadding = " ".repeat(Math.max(0, contentWidth - visibleWidth(hint)));
                result.push(`${leftPadding}${hint}${hintPadding}${rightPadding}`);
            }
        }
        return result;"""
if old not in src:
    print(f"editor.js: render block not found — pi-tui version may have changed ({path})", file=sys.stderr)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(src.replace(old, new, 1))
print(f"editor.js: keys hint patched ({path})")
PY

echo "OK — restart pi for the changes to take effect."

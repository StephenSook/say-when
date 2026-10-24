#!/usr/bin/env bash
# Pre-commit hook: warn if a staged file sits under someone else's active (🟡) task in PLAN.md.
# Install: git config core.hooksPath .githooks
# Warns only; it never blocks a commit. Set PLAN_NAME to the name you use in the Owner column.

PLAN="PLAN.md"
[ -f "$PLAN" ] || exit 0

me="${PLAN_NAME:-$(git config user.name)}"
me_lc=$(printf '%s' "$me" | tr '[:upper:]' '[:lower:]')
changed=$(git diff --cached --name-only)
[ -n "$changed" ] || exit 0

grep '^| .*| 🟡 |' "$PLAN" 2>/dev/null | while IFS='|' read -r _ num component files owner status deps notes _; do
    owner=$(printf '%s' "$owner" | sed 's/\*\*//g' | xargs)
    [ -n "$owner" ] || continue

    # Skip rows I own. Owner can be "Shashank" or "Shashank + Stephen".
    mine=no
    for o in $(printf '%s' "$owner" | tr '+' ' '); do
        o_lc=$(printf '%s' "$o" | tr '[:upper:]' '[:lower:]')
        case "$me_lc" in *"$o_lc"*) mine=yes ;; esac
    done
    [ "$mine" = yes ] && continue

    # The File(s) cell can list several paths: `a/`, `b/`
    for pattern in $(printf '%s' "$files" | tr -d '`' | tr ',' ' '); do
        [ "$pattern" = "-" ] && continue
        for path in $changed; do
            case "$path" in
                "$pattern"*)
                    echo ""
                    echo "⚠️  WARNING: you are editing '$path'"
                    echo "   which belongs to $owner's active task $(echo "$num" | xargs) (🟡)."
                    echo "   Check PLAN.md and talk to them before pushing."
                    echo ""
                    ;;
            esac
        done
    done
done

exit 0

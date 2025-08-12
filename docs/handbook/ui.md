## UI Behaviors

Views and filters
- Anchor date with Day/Week/Month determines the Scheduled range
- Sections: Today, Scheduled, All, Flagged (priority=high), Backlog
- Toggle: show completed across lists

Interactions
- Quick entry: add directly (defaults to anchor date) or send instruction to LLM for proposals
- Edit: inline modal to change title, notes, scheduled date, priority
- Complete/uncomplete: checkbox on each row; visually dims and strikes through
- Delete: confirmation dialog
- Search: debounced; results shown in a side panel without losing context
- Import: upload `.txt`; deduplicate exact lines within the import session; bulk create via apply

LLM proposal review
- Panel lists proposed operations with checkboxes
- You select which operations to apply; server responds with a summary and items update

Notes
- Single user; no accounts. All state is local.
- Flutter Web UI targets desktop web; can later be reused for mobile without API changes.

URL state (recommended)
- Persist `anchor`, `view`, and `completed` in the URL so refresh preserves context
- Example: `?anchor=2025-08-12&view=week&completed=false`

Keyboard affordances (guidelines)
- Enter to submit Quick Entry; Esc to cancel dialogs; Tab order: Quick Entry → Search → anchor → view → toggle
- Focus indicators on actionable controls

Import workflow details
- Reads `.txt`, splits on newlines, trims empties, deduplicates within this import
- Choose schedule: anchor date or unscheduled (Backlog)
- Choose a default priority; apply creates one operation per selected line

Sorting and grouping (recommended)
- Scheduled views: group items by `scheduledFor` in ascending order; within a date group, stable by creation time
- Backlog: show `priority` buckets (e.g., High first), then by creation time

Accessibility
- All interactive elements should be reachable via keyboard and have visible focus
- Use aria-labels for controls without text
- Ensure sufficient color contrast for status indicators (e.g., completed strike-through)



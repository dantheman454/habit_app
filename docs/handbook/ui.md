## UI Behaviors

Views and filters
- Anchor date with Day/Week/Month determines the Scheduled range
- Sections: Today, Scheduled, All, Flagged (priority=high), Backlog
- Toggle: show completed across lists

Interactions
- Quick actions sheet: create, update, complete, delete
- Edit: modal to change title, notes, scheduled date, priority
- Complete/uncomplete: checkbox on each row; visually dims and strikes through
- Delete: confirmation dialog
- Search: debounced; results shown in a panel above main list
- Import: removed in current UI

```468:575:apps/web/flutter_app/lib/main.dart
// Header: search-only (debounced)
// ...
// Main lists + Assistant panel (right side)
// FloatingActionButton opens Quick Actions sheet supporting create/update/complete/delete
```

Assistant plan review
- Panel lists proposed operations with checkboxes and shows a short assistant summary
- You select which operations to apply; server responds with a summary and items update

```558:575:apps/web/flutter_app/lib/main.dart
SizedBox(
  width: 360,
  child: AssistantPanel(
    transcript: assistantTranscript,
    operations: assistantOps,
    operationsChecked: assistantOpsChecked,
    sending: assistantSending,
    // ...
  ),
),
```

Notes
- Single user; no accounts. All state is local.
- Flutter Web UI targets desktop web; can later be reused for mobile without API changes.

URL state (note)
- The current Flutter UI does not persist URL state.

Keyboard affordances (guidelines)
- Enter to submit dialogs; Esc to cancel dialogs
- Focus indicators on actionable controls

Import workflow details
- Import UI removed in current build

Sorting and grouping
- Lists are grouped by `scheduledFor` with a simple ascending header; within groups, order is storage order

```599:613:apps/web/flutter_app/lib/main.dart
Widget _buildMainList() {
  final grouped = _groupByDate(items);
  return ListView(
    // renders date headers and items beneath
  );
}
```

Accessibility
- All interactive elements should be reachable via keyboard and have visible focus
- Use aria-labels for controls without text
- Ensure sufficient color contrast for status indicators (e.g., completed strike-through)



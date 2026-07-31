# Store listing copy

## Short description

Add saved, count-bearing views to GitHub notifications, pull requests, and issues.

## Detailed description

jdx Flavored GitHub reduces notification noise without replacing GitHub's inbox
or requiring an API token.

- Adds compact saved-view chips with counts to Notifications, Pull Requests,
  and Issues.
- Adds a branded GitHub-header shortcut to view and grouping settings.
- Syncs preferences through Chrome and supports JSON backup and restore.
- Uses a compact master/detail editor for adding, renaming, reordering,
  deleting, and editing saved views and reusable notification rules.
- Lets users set a separate default view for each surface.
- Supports per-repository Pull Request and Issue overrides with Global
  inheritance.
- Untouched surfaces automatically receive improved built-in views on updates;
  customized surfaces remain pinned until restored.
- Includes a boolean notification DSL with composable named rules and uses
  GitHub search syntax for PR and issue view definitions.
- Hides draft and team-mention notification noise.
- Ships a Focused rule that prioritizes direct @username mentions and remains
  fully editable.
- Gates GitHub's global unread dot and live new-notification banner with the
  selected global default notification view.
- Keeps closure notifications available for deliberate inbox triage.
- Offers repository-scoped **Mark all merged as done** actions only where
  merged notifications are present.
- Supports personal title rules for release PRs and other predictable noise.
- Surfaces Open, Draft, Merged, Closed, direct-mention, and failing-check status
  directly on notification rows.
- Can keep failures on your PRs while filtering failures authored by others.
- Can hide closed issues and subscribed-only notifications.
- Conservatively dims bot-only activity.
- Generates filtered-reason pills from named rules, reveals each reason
  independently, and marks every newly revealed row with a subtle blue line.
- Works independently of Refined GitHub and alongside it.

No analytics, remote code, tracking, or data collection.

## Single purpose

Add saved views to GitHub's native notification, pull request, and issue pages.

## Permission justification

- `storage`: Saves the user's filter and visibility settings through Chrome's
  sync storage.
- `https://github.com/*`: Applies those settings to GitHub's native pages.

## Data use

No user data is collected or transmitted. Settings remain in Chrome's extension
storage and may sync through the user's Chrome account.

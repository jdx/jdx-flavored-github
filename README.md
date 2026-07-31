<p align="center">
  <img src="icons/icon.svg" width="96" height="96" alt="jdx Flavored GitHub logo">
</p>

# jdx Flavored GitHub

<img width="714" height="564" alt="Screenshot 2026-07-31 at 01 04 30" src="https://github.com/user-attachments/assets/8b9b7b5a-2142-4500-be68-adc5818f863d" />

A Chrome extension for turning GitHub’s Notifications, Pull Requests, and
Issues pages into focused, saved views.

It works on GitHub’s existing pages, uses your existing session, and does not
require an API token or background polling.

## Focus on the work that needs you

**Focused** is the default notification view. It cuts common noise such as
drafts, team mentions, and blocked work on someone else’s PR while keeping your
own failing, pending, or conflicting PRs in view.

Focused is a normal editable rule, not a special mode. Its shipped definition
prioritizes direct mentions, but every part of that behavior can be changed in
the view editor.

The notification page also gains PR check and merge-conflict status,
per-repository explanations for filtered items, and collapsible groups for
related notifications. Pull Request and Issue lists support the same
collapsible author and dependency-update groups.

## Make it yours

Build count-bearing views for Notifications, Pull Requests, and Issues, choose
the default for each page, and edit them without leaving GitHub. Views support
three inheritance levels:

```text
Global → user or organization → repository
```

Each level can override Notifications, Pull Requests, and Issues independently.
Removing an override resumes inheritance from its parent.

Settings sync through Chrome. They can also be exported and imported as JSON.

## Act on a whole view

Rules and views can define named actions for:

- Marking notifications Done, read, or unread
- Closing or reopening pull requests and issues
- Adding or removing labels
- Opening matches in tabs

Every action previews the loaded targets before changing anything. Unloaded
search results are never assumed to be in scope.

## Install for development

1. Clone this repository.
2. Run `mise install` to install the pinned aube version.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the repository directory.

After changing the source, reload the extension and refresh GitHub.

## Notification rules

Notification rules use GitHub-like qualifiers with boolean composition:

```text
reason:mention OR (reason:review-requested AND bot:false)
```

Whitespace means `AND`. Explicit `AND`, `OR`, `NOT`, parentheses, and
`-qualifier` exclusions are supported.

Available qualifiers include:

```text
repo:        org:          author:       reason:
is:          rule:         draft:        conflict:
status:      label:        bot:          title:/pattern/i
```

Labels containing spaces must be quoted:

```text
label:"release candidate"
```

Rules can be visible views, filtered-reason pills, or hidden helpers. The
default Focused rule is composed entirely from helpers:

```text
rule:direct-mention OR (
  NOT rule:draft
  AND NOT rule:team-mention
  AND NOT rule:other-failing
  AND NOT rule:other-pending
  AND NOT rule:other-conflicting
)
```

For example, a personal hidden rule for release PRs could use:

```text
is:pr label:release
```

Then add `AND NOT rule:release-pr` to Focused. This is intentionally not part of
the shipped default.

Pull Request and Issue views use GitHub’s search syntax directly:

```text
is:open is:pr draft:false
is:open is:issue assignee:@me
```

## How metadata is loaded

The extension reads GitHub’s same-origin pages and deferred status responses
using the current browser session. Check results and PR metadata are cached
locally for five minutes to avoid repeating work during navigation.

Exact per-PR check results take priority over GitHub search rollups, so a
failure is not mislabeled as pending just because another check is still
running. GitHub’s merge-box data supplies `conflict:true` and the conflict
icon.

Chrome sync contains user-controlled settings only. Temporary GitHub metadata
stays in local extension storage. The extension has no analytics, remote code,
or data collection.

## Refined GitHub

jdx Flavored GitHub can run alongside Refined GitHub. It neutralizes the
notification-row layout changes from Refined GitHub’s CSS-only
`clean-notifications` feature, so there is no setting to disable.

Refined GitHub’s `notifications-ui`, `sticky-notifications-actions`,
`select-notifications`, and `open-all-notifications` features are compatible.

## Development

Run the test suite:

```sh
aube test
```

Before packaging:

1. Test Notifications, Pull Requests, and Issues with the unpacked extension.
2. Verify the version in `manifest.json`.
3. Create a ZIP with `manifest.json` at its root.

This project has not yet had a public release. Change schemas and built-in
defaults directly until it does.

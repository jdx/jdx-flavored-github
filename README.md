# jdx Flavored GitHub

jdx Flavored GitHub is a tokenless Chrome extension that adds saved, count-bearing
views to GitHub's native Notifications, Pull Requests, and Issues pages.

- Starts with useful built-in notification, pull-request, and issue views.
- Lets you add, rename, reorder, edit, and delete view chips.
- Lets you choose a separate default view for each surface.
- Supports global, user/organization, and repository-specific Notification,
  Pull Request, and Issue views.
- Adds an **Edit views** action that switches the current GitHub page into an
  inline view editor.
- Includes expandable, surface-specific syntax help inside the inline editor.
- Uses a compact master/detail editor: all views and rules remain visible as
  single-line summaries while only the selected item exposes its multiline DSL.
- Adds a branded button beside GitHub’s notification control on every page;
  it opens extension settings, including notification grouping defaults.
- Syncs all user-controlled settings through Chrome sync and supports strict
  JSON export/import for portable backups. Temporary GitHub data caches remain
  local and are not exported.
- Stores only customized surfaces as overrides, so untouched users receive new
  built-in views when the extension updates.
- Provides **Restore default filters** per surface in the editor.
- Gives notification views a safe boolean DSL; PR and issue views use GitHub’s
  native search syntax.
- Defines Focused as editable DSL composed from named, reusable notification
  rules for drafts, team mentions, direct mentions, check states, and merge
  conflicts. Conflicts on someone else’s PR are hidden; conflicts on your own
  PR remain visible.
- Hides saved-view pills with no matches while keeping the active view visible.
- Keeps closed and merged notifications visible by default so they can be
  deliberately marked Done.
- Lets any notification rule, pull-request view, or issue view define opt-in
  bulk-action recipes. Every run previews the currently loaded matches before
  applying notification state changes, PR close/reopen, issue close/reopen,
  labels, or opening the matches in tabs.
- Ships “Mark as done” on the hidden Merged notifications rule, so each
  repository gets that action only when it has matching notifications.
- Lets you hide the **jdx** settings shortcut from GitHub’s header while keeping
  the options page available from Chrome’s extension management page.
- Lets direct @username mentions bypass every Focused suppression rule.
- Shows GitHub's global blue notification indicator only when the global
  default notification view contains unread notifications.
- Shows GitHub's live “new unread notifications” banner only when at least one
  newly arrived notification matches that same global default view.
- Displays PR check state—passing, pending, or failing—beside the PR number,
  plus direct mentions on notification rows. A conflicting PR instead gets a
  distinct red conflict icon in place of its ordinary draft/open/merged icon.
- Summarizes filtered notifications as count-bearing reason pills beneath each
  repository and lets each reason be revealed independently per project.
- Marks every temporarily revealed row with a slim blue left-edge indicator,
  so newly added rows remain obvious in long lists without adding more text.
- Keeps one real PR notification visible for each stack and adds an inline
  expander that reveals the remaining notifications.
- Collapses Dependabot and Renovate PRs by default, with an optional setting to
  group other PR notifications from the same author.

It works independently of Refined GitHub and can be installed alongside it.

## Pre-release policy

This extension has not been published. Until its first public release, replace
schemas and defaults directly: do not add legacy syntax, compatibility aliases,
or storage migrations.

## Refined GitHub compatibility

Refined GitHub's `clean-notifications` feature is CSS-only and does not appear
as a switch in Refined GitHub's settings. jdx Flavored GitHub neutralizes that
feature's notification-row layout rules automatically, so you do not need to
disable Refined GitHub.

Refined GitHub's `notifications-ui`, `sticky-notifications-actions`,
`select-notifications`, and `open-all-notifications` features are compatible.
The `subscribed`, `mention`, and similar labels at the right of notification
rows are native GitHub notification reasons, not added by Refined GitHub.

## Test locally

Run the automated checks:

```sh
npm test
```

Then load the extension in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this directory.
5. Open a repository's **Pull requests** tab. The Ready view should be selected
   by default and the chip bar should show GitHub result counts.
6. Open a repository's **Issues** tab and verify its saved-view chips.
7. Open <https://github.com/notifications>. The Focused chip should be selected,
   each chip should show a count, and filtered rows should be summarized by
   reason beneath their repository group.
8. Click **Edit views** to edit names, ordering, DSL, and defaults without
   leaving GitHub. Repository notification groups expose the same editor through
   **Customize views**.

## View DSL

Notification views use a superset of GitHub's notification filter syntax.
GitHub-style whitespace means `AND`; explicit `AND`, `OR`, `NOT`, parentheses,
and `-qualifier` exclusions are also supported.

Native-style qualifiers include `repo:`, `org:`, `author:`, `reason:`, and
`is:`. Named rules can be composed with `rule:rule-id`. The extension adds
familiar PR-search qualifiers including `is:pr`,
`is:issue`, `is:merged`, `draft:true`, `conflict:true`, `status:failure`, `status:pending`,
`status:success`, `label:release`, `bot:true`, and `title:/pattern/i`. Quote
labels containing spaces, for example `label:"release candidate"`.

Every notification item is a named rule. A rule can be exposed as a view chip,
used as a filtered-reason pill, both, or kept as a helper rule. Focused is a
view-chip rule composed from the shipped helpers:

```text
rule:direct-mention OR (
  NOT rule:draft
  AND NOT rule:team-mention
  AND NOT rule:other-failing
  AND NOT rule:other-pending
  AND NOT rule:other-conflicting
)
```

For example:

```text
reason:mention OR (reason:review-requested AND bot:false)
```

Personal rules can be added without changing the defaults shipped to other
users. For example, a hidden filtered-reason rule named “Release PR” can use:

```text
is:pr label:release
```

Focused can then add `AND NOT rule:release-pr`.

Pull request and issue views use GitHub search qualifiers directly, such as
`is:open is:pr draft:false` or `is:open is:issue assignee:@me`.

## View scopes

View inheritance is **Global → user/organization → repository**. Each scope can
override its Notification, Pull Request, and Issue surfaces independently.
Removing an override makes that surface inherit from its nearest configured
parent immediately.

The top notification chips remain global because the inbox combines many
repositories. Repository defaults apply on initial load; explicitly selecting a
top chip applies that view inbox-wide. Filtered-reason pills remain scoped to
each project.

Check-state rules load GitHub's native `status:failure`, `status:pending`,
`status:success`, and `author:@me` searches for each repository represented in
the inbox. Results are cached in Chrome local storage: five minutes as fresh
data and up to one hour as immediate stale data while a background refresh
runs. They do not use an API token.

GitHub search can report a pull request as pending while one check is still
running even though another check has already failed. The extension therefore
loads every notified PR page without the browser HTTP cache, follows GitHub’s
deferred head-commit status endpoint, and treats that exact result as the
higher-priority per-PR value; any known failure wins over the coarser search
rollup.

Open pull requests also load GitHub’s native merge-box data. A
`mergeStateStatus` of `DIRTY` powers `conflict:true`, the Focused helper rule,
and the dedicated conflict icon.

## Bulk-action recipes

Add actions to the selected rule or view from the same master/detail editor.
An action has a name and one or more ordered steps. Notification recipes can
mark matching notifications Done, read, or unread. Pull-request recipes can
close or reopen PRs. Issue recipes can close or reopen issues. PR and issue
recipes can also add or remove a label, and every surface can open matches in
tabs.

Running an action always opens a confirmation preview listing the loaded
targets. The extension never assumes unloaded search results are in scope.
GitHub’s native lifecycle/label bulk form reloads the list, so those steps must
be last in a multi-step recipe.

Stack detection reads the base and head branches embedded in GitHub's own PR
pages, connects notified PRs whose branches form a chain, and caches that
metadata for five minutes. It does not require Graphite metadata or an API
token.

Dependency-update grouping uses the author embedded in the same page data.
Same-author grouping for other contributors is available as an opt-in setting.

## Chrome Web Store release

Upload `jdx-flavored-github-0.1.0.zip` from the release directory, complete the
store listing and privacy declarations, and submit it for review.

The extension has one purpose: making GitHub's native notification and pull
request pages more actionable. It stores only user-facing settings in Chrome
sync storage. It does not collect, transmit, or sell user data.

## Updating

1. Change `version` in `manifest.json`.
2. Test the unpacked extension again.
3. Zip the contents of this directory, with `manifest.json` at the root.
4. Upload the new ZIP to the existing Chrome Web Store item.

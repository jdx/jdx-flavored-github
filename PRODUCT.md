# Product direction

## Positioning

jdx Flavored GitHub is a saved-views layer for GitHub's native Notifications,
Pull Requests, and Issues pages. It does not replace the inbox, poll in the
background, or require an access token.

## Repeated user problems

1. Team mentions and team review requests create high-volume, low-intent noise.
2. Closed and merged items remain mixed with actionable work.
3. Bot activity can drown out human activity.
4. GitHub's notification inbox records events, while developers need current
   state: what is open, ready, blocked, or waiting on them.
5. Pull request lists do not make review routing obvious.

## Evidence

- GitHub Community #15591: users have asked for open/closed notification
  filtering for years, with repeated complaints about merged PR noise.
  <https://github.com/orgs/community/discussions/15591>
- GitHub Community #56926: team review requests overwhelm direct personal
  review requests.
  <https://github.com/orgs/community/discussions/56926>
- GitHub Community #48031: CODEOWNERS group requests pollute the personal
  review queue.
  <https://github.com/orgs/community/discussions/48031>
- Refined GitHub #5780: bot notifications drown out human activity.
  <https://github.com/refined-github/refined-github/issues/5780>
- Refined GitHub #9282: maintainers want open/draft status in Notifications,
  but Refined GitHub declined a second filtering UI.
  <https://github.com/refined-github/refined-github/issues/9282>

Recent Chrome extensions such as GitHush and Alerts for GitHub replace the
inbox and poll GitHub's API. jdx Flavored GitHub's niche is improving GitHub's native
pages without a token, background polling, or a separate inbox.

## Tokenless version

- Filter rows using GitHub's own notification reason metadata and status icons.
- Treat direct `mention` as a priority override while suppressing
  `team_mention`.
- Preserve merged and closed notifications so users can mark them Done and
  still receive later thread activity.
- Match personal release-PR naming conventions with local regular expressions.
- Match failing checks through cached, same-origin GitHub search pages.
- Distinguish the user's failing and pending PRs from other authors’ PRs with
  `author:@me`.
- Keep all filtering reversible and non-destructive.
- Present useful built-in views as compact, count-bearing chips.
- Let users add, rename, reorder, delete, and edit every chip.
- Keep separate defaults for Notifications, Pull Requests, and Issues.
- Let repositories override Notification, Pull Request, and Issue views
  independently while inheriting all untouched surfaces from Global.
- Provide a small boolean notification DSL and reuse GitHub search syntax for
  pull requests and issues.
- Keep Edit views available directly in each chip bar as an inline editing
  mode, without navigating away from GitHub.
- Persist only customized surfaces; untouched surfaces inherit future built-in
  changes automatically.
- Put Restore default filters in the editor, where it removes the override and
  resumes built-in inheritance.
- Use native GitHub searches for PR and issue views, and loaded-page counts for
  notification views.
- Append further inbox pages through GitHub's own pagination when the active
  view filters out most of a page, so a focused inbox is not left nearly empty.
- Summarize filtered notifications with per-project reason facets that reveal
  each category independently without affecting other repositories.
- Collapse connected pull-request chains behind an inline expander on a real
  representative notification.
- Collapse Dependabot and Renovate updates by default, with opt-in grouping for
  other pull requests from the same author.
- Avoid background polling, write actions, and access-token handling.

## Enhanced-mode candidates

These require metadata that GitHub does not expose through the tokenless,
same-origin page reads currently used by the extension:

- Exact "no reviewer has been requested" detection.
- Distinguishing direct review requests from team review requests inside the
  notification inbox.
- Detecting the actual PR author when only recent participant avatars are
  visible.
- Ranking work by CI, mergeability, age, or requested-review state.

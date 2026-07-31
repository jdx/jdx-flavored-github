<p align="center">
  <img src="icons/icon.svg" width="96" height="96" alt="jdx Flavored GitHub logo">
</p>

# jdx Flavored GitHub

A Chrome extension to fix behavior in ways that @jdx needs for his workflow—but customizable too so it should fit yours!
Right now this modifies:

- GitHub Notification Inbox
- GitHub Pull Request Repo List
- GitHub Issue Repo List

It works on GitHub’s existing pages, uses your existing session, and does not
require an API token. No promises it will always remain that way but so far I don't seem to need a token.

## Focused inbox

The killer feature for me is the Focused inbox:

<img width="714" height="564" alt="Screenshot 2026-07-31 at 01 04 30" src="https://github.com/user-attachments/assets/8b9b7b5a-2142-4500-be68-adc5818f863d" />

You can customize what "focused" means for you but by default it's:

- any notification that directly tags me (not a group) is always displayed
- hides notifications about draft PRs unless authored by me
- hides notifications about PRs with merge conflicts or PR check status as pending/failed unless authored by me
- collapses stacked PRs or PRs by dependabot/renovate into a single, expandable item

For me, this fits my workflow because PR notifications that someone else needs to finish I simply won't see until it's ready.

## Pull Requests / Issues

You can default the pull request and issue list pages on repos to different filters. The default is to hide draft PRs not created by me. I don't use issues in my projects so there is no default view, but you can create your own if you like.

You customize per repo/org or globally.

## Views/Rules

jdx Flavored Markdown has 2 important concepts:

- **Views** – the pill you see above PR/issue/notification lists. e.g.: "focused" or "my failing PRs"
- **Rules** – subcomponent of views, shown at the _bottom_ of the list to subfilter. e.g.: "my draft PRs" or "other created issue" or "dependabot PRs"

The reason for 2 is it makes it easy to add back in items filtered out for different reasons without needing to add all of the items.

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

jdx Flavored GitHub can run alongside Refined GitHub.

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

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

[Install jdx Flavored GitHub from the Chrome Web Store](https://chromewebstore.google.com/detail/jdx-flavored-github/dmiieoopojnjepheeimdcdlhdhdfiija)

## Focused inbox

The killer feature for me is the Focused inbox:

<img width="714" height="564" alt="Screenshot 2026-07-31 at 01 04 30" src="https://github.com/user-attachments/assets/8b9b7b5a-2142-4500-be68-adc5818f863d" />

You can customize what "focused" means for you but by default it's:

- any notification that directly tags me (not a group) is always displayed
- hides notifications about draft PRs unless authored by me
- hides notifications about PRs with merge conflicts or PR check status as pending/failed unless authored by me
- collapses stacked PRs or PRs by dependabot/renovate into a single, expandable item

For me, this fits my workflow because PR notifications that someone else needs to finish I simply won't see until it's ready.

## Extra inbox pages

GitHub paginates the inbox before any view filters it, so a page of mostly
draft and bot activity can leave Focused nearly empty. The extension keeps
loading the next inbox page—using GitHub’s own pagination and your existing
session—until the active view has enough notifications, then rewires the
**Next** link to continue past everything it appended.

Both the behavior and the target count are in Options under **Inbox pages**;
loading is capped at five extra pages per visit.

## Pull Requests / Issues

You can default the pull request and issue list pages on repos to different filters. Pull requests default to Ready, which shows open, non-draft PRs. Issues default to All.

You customize per repo/org or globally.

By default, stacked PRs and dependabot/renovate PRs will collapse like this on Notification Inbox and Pull Request pages:

<img width="928" height="217" alt="Screenshot 2026-07-31 at 09 36 16" src="https://github.com/user-attachments/assets/17f19943-e126-4396-82d0-cc33f4387cef" />

Groups you expand stay expanded after a refresh. That memory is stored locally,
holds the 300 most recently expanded groups, and forgets a group after 30 days.

## Views/Rules

jdx Flavored Markdown has 2 important concepts:

- **Views** – the pill you see above PR/issue/notification lists. e.g.: "focused" or "my failing PRs"
- **Rules** – subcomponent of views, shown at the _bottom_ of the list to subfilter. e.g.: "my draft PRs" or "other created issue" or "dependabot PRs"

The reason for 2 is it makes it easy to add back in items filtered out for different reasons without needing to add all of the items.

## Install for development

1. Clone this repository.
2. Run `mise install` to install the pinned aube version.
3. Run `aube build`.
4. Open `chrome://extensions`.
5. Enable **Developer mode**.
6. Click **Load unpacked**.
7. Select the repository's `dist` directory.

Run `aube dev` while editing TypeScript. After a build, reload the extension
and refresh GitHub.

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
using the current browser session. Check results are cached locally for five
minutes. Stable PR grouping facts are cached for 24 hours so collapsed groups
can render immediately after reload while full metadata refreshes in the
background.

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

TypeScript source lives in `src/`. `aube build` typechecks and bundles the
content script, options page, and service worker into the ignored `dist/`
directory while copying the manifest, styles, HTML, and icons. Chrome should
always load `dist`, not the repository root.

`icons/icon.svg` is the canonical logo and the source for `icon-128.png` and
`icon-48.png`. `icons/icon-small.svg` is the same mark with a heavier stroke, a
larger tittle, and a tighter corner radius so it survives rasterization, and is
the source for `icon-32.png` and `icon-16.png`. Regenerate the PNGs from those
two files whenever either changes.

Run the test suite:

```sh
aube test
```

## Releases

Merges to `main` update a release pull request from Conventional Commit titles.
That pull request updates the changelog and `manifest.json` version. Merging it
creates a GitHub release, runs the full test suite, and attaches a Chrome-ready
ZIP with `manifest.json` at its root.

If packaging fails, rerunning the workflow resumes the latest draft release.

The release workflow can also upload the archive to the Chrome Web Store and
submit it for review. Configure a `chrome-web-store` GitHub environment with
these variables:

- `CWS_EXTENSION_ID`: the extension ID from the Developer Dashboard.
- `CWS_PUBLISHER_ID`: the publisher ID from **Publisher > Settings**.
- `CWS_SERVICE_ACCOUNT`: a Google Cloud service account email added under the
  Chrome Web Store Developer Dashboard's **Account** section.
- `CWS_WORKLOAD_IDENTITY_PROVIDER`: the full Google Cloud Workload Identity
  Provider resource name trusted to authenticate this repository's release
  workflow.

Enable the Chrome Web Store API in the service account's Google Cloud project,
then grant this repository's Workload Identity principal
`roles/iam.workloadIdentityUser` on the service account. The release job uses
GitHub's OIDC token to obtain a short-lived access token, so no service account
key is stored in GitHub. The store listing and privacy details must already be
complete, and visibility changes must be published manually once before API
publishing can use them.

Run `scripts/setup-chrome-web-store.sh` to create the service account and
repository-scoped Workload Identity Federation configuration for this project.
The workflow can also be dispatched manually with a specific draft tag.

This project has not yet had a public release. Change schemas and built-in
defaults directly until it does.

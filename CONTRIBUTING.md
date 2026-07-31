# Contributing

## Setup

1. Install the pinned tools with `mise install`.
2. Build the extension with `aube build`.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select this repository's `dist/` directory.

After rebuilding, reload the extension on `chrome://extensions` and refresh the
GitHub page being tested.

## Before opening a pull request

Run the automated tests:

```sh
aube test
```

Every bug fix and feature must also be verified manually in Chrome:

1. Run `aube build` from the final commit.
2. Load the generated `dist/` directory as an unpacked Chrome extension.
3. Reproduce the affected workflow on GitHub and confirm the fix or feature
   works as intended.
4. Check related Notifications, Pull Request, or Issue list behavior for
   obvious regressions.

The pull request template includes a manual Chrome verification checkbox. Open
the pull request with this box unchecked. After completing the steps above,
the human contributor must personally click the checkbox in the GitHub pull
request UI. Automation and AI agents must not pre-check it or mark it complete
on the contributor's behalf.

Pull request titles must follow the Conventional Commits guidance in
[AGENTS.md](AGENTS.md).

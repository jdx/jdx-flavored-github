# Contributing

## Setup

1. Install the pinned tools with `mise install`.
2. Build the extension with `aube build`.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select this repository's `dist/` directory.

After rebuilding, reload the extension on `chrome://extensions` and refresh the
GitHub page being tested.

## Linting and formatting

[oxlint](https://oxc.rs/docs/guide/usage/linter) checks the code and
[oxfmt](https://oxc.rs/docs/guide/usage/formatter) formats it. Both are pinned
as dev dependencies and enforced in CI.

```sh
aube run lint
aube run format
```

Use `aube run lint:fix` to apply the linter's automatic fixes and
`aube run format:check` to verify formatting without rewriting files.

Formatting is two-space indentation, single quotes, semicolons, trailing
commas, and a 100-column print width, configured in
[.oxfmtrc.json](.oxfmtrc.json). Do not hand-format; run the formatter.

The lint rules live in [.oxlintrc.json](.oxlintrc.json) and enable oxlint's
`correctness`, `suspicious`, and `perf` categories. A few rules are turned off
because they conflict with deliberate patterns in this codebase: sequential
`await` in loops is intentional for GitHub request pacing, trailing-underscore
parameter names avoid shadowing globals such as `document`, in-place `sort()`
is applied to arrays this code just built, and object spreads inside `map()`
are kept for readability.

## Before opening a pull request

Run the automated tests and checks:

```sh
aube test
```

```sh
aube run lint
```

```sh
aube run format:check
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

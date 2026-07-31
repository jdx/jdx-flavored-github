# Repository Agent Guide

## Pull request titles

All pull request titles must use Conventional Commits format:

```text
<type>(<scope>): <description>
```

The scope is optional. Use the narrowest useful subsystem when one is clear,
such as `notifications`, `views`, `dsl`, `options`, `build`, or `deps`.

Supported types are `feat`, `fix`, `refactor`, `chore`, `docs`, `style`,
`test`, `perf`, `build`, `ci`, `revert`, and `security`.

- Write the description in imperative mood.
- Use lowercase after the colon.
- Keep the title concise and descriptive.
- Use `!` after the type or scope for a breaking change.
- Do not add a tool name, emoji, or manually typed pull request number.

Examples:

- `feat(notifications): add repository-scoped views`
- `fix(build): refresh static assets in watch mode`
- `refactor(dsl): split parsing from evaluation`
- `docs: explain Refined GitHub compatibility`
- `feat(options)!: replace the exported settings schema`

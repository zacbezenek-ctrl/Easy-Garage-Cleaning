@AGENTS.md

## Claude Code notes

- Cloud containers: Chromium is preinstalled at `/opt/pw-browsers`. Never run `playwright install`; use the
  "Container recipe" in `docs/testing.md`.
- Put isolated worktrees under `.claude/worktrees/`: it is gitignored, and `sourceFiles()` skips it, so repo-wide
  test scans never read another checkout.
- Use the GitHub MCP tools for issues and PRs. Label your claim issue and your PR `agent:claude`.
- Keep the scratch output of test runs (logs, screenshots) out of the repo: `test-results/` and `field-qa/` are
  gitignored, anything else goes in your scratchpad.

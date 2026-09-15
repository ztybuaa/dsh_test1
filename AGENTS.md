# AGENTS.md

为 DeepSeek Harness 官方 Electron 桌面版提供「侧边栏内嵌一个真实浏览器、并可被 agent 驱动」的插件。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `ztybuaa/dsh_test1`; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles mapped to same-named labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

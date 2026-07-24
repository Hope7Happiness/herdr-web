# Agent-to-agent coordination

herdr ships an [agent skill](https://herdr.dev/docs/agent-skill/) that
teaches a coding agent running *inside* a herdr pane to drive its siblings
through the `herdr` CLI: split panes, start named agents, prompt them, wait
on their lifecycle state, and read their output. herdr-web sits on top of
the same session, so the whole exchange is visible (and drivable) from your
phone.

## A real exchange, driven from the web UI

We prompted the agent named **main** from the phone UI:

> Use herdr to coordinate with another agent: split a pane, start a claude
> agent named helper in it, prompt helper with: *Reply with exactly the word
> BAAA-CONFIRMED and nothing else.* Wait for helper to finish, read its
> answer, and report back what helper replied.

main ran, via the skill:

```bash
herdr pane split --current --direction down --cwd "$PWD" --no-focus
herdr agent start helper --kind claude --pane w1:p2
herdr agent prompt helper "Reply with exactly the word BAAA-CONFIRMED and nothing else." --wait --timeout 120000
herdr agent read helper --source recent-unwrapped --lines 60
```

…and reported: *"Done. Helper replied with exactly: BAAA-CONFIRMED."*

Both named agents appear as tabs in the web UI, switchable mid-exchange —
main's view on the left, helper's pane (with the prompt main sent it) on
the right:

<p>
  <img src="verification/emu4-02-main.png" width="270" alt="main's coordination report">
  <img src="verification/emu4-03-helper.png" width="270" alt="helper's pane with the reply">
</p>

## Notes

- Agent permission prompts (e.g. Claude Code approving the skill's shell
  commands) surface in herdr-web as **blocked** status — the toast/bell
  flow is exactly how you approve them from the phone (Enter quick key).
- The web UI's own submits use the same primitive the skill uses
  (`agent.prompt`), which submits text + Enter atomically while honoring
  the pane's bracketed-paste mode.
- Setup used here: `herdr integration install claude` (lifecycle-state
  hook) + the herdr skill installed for the agent, plus a project-scoped
  permission allowing `herdr` CLI calls.

# ADR-052 — every hook runs the launcher in a shell

**Date:** 2026-11-02 · **Status:** accepted · **Governs:** `hooks/hooks.json`, `bin/spec-flow`, `internal/build`, `hooks/live-view.tsx` · **Supersedes:** ADR-051's exec form and the Windows binary's place

**Question.** ADR-051 ran each hook in exec form, `${CLAUDE_PLUGIN_ROOT}/bin/spec-flow` with `["hook", "<name>"]`. On macOS and Linux that is the launcher; on Windows, which cannot run a shell script, the Windows binary sat beside it as `bin/spec-flow.exe`, on the assumption that a spawn of `bin/spec-flow` there finds `bin/spec-flow.exe`. Does anything promise that?

**Measured.**
- Claude Code's hooks documentation says exec form on Windows "requires `command` to resolve to a real executable such as a `.exe`", and says nothing on whether `.exe` is appended to a path that names none. Go's own spawn appends it; Claude Code's had never been run.
- Shell form is documented on every platform: `sh -c` on macOS and Linux, Git Bash on Windows, PowerShell where Git Bash is not installed. There, "a shell-form `PreToolUse` … command hook that fails with `onFailure` unset can instead block the tool call".
- On Linux a hook call costs the same through `sh -c` as spawned directly: about 18 ms each way, over 100 calls.

**Decision.**
- Every entry in `hooks.json` is `"${CLAUDE_PLUGIN_ROOT}/bin/spec-flow" hook <name>` in the default shell. The launcher picks `bin/<os>-<arch>/spec-flow` on every platform, Windows included: under Git Bash it runs `bin/windows-amd64/spec-flow.exe`.
- On Windows the engine needs Git Bash, the shell Claude Code itself uses there. Where it is missing, the hooks run in PowerShell, which cannot run the launcher. So every `PreToolUse` hook sets `"onFailure": "continue"`: the engine does not run, and says so in a hook error notice on each call, rather than blocking every Read, Write and spawn in the session.
- The live view has no shell. It runs the launcher, and where that cannot start, the Windows binary by its path.

**Refused.**
- **Exec form with an implied `.exe`.** It rests on an undocumented behaviour of one spawner.
- **Dropping native Windows for WSL.** That would remove the `.exe`, but the engine has run on Windows since it ran on Node, and CI keeps a Windows leg for that reason.
- **One command string both bash and PowerShell run.** None reads the same in both.
- **`"shell": "bash"` set explicitly.** What it does without Git Bash is undocumented.

**Cost.** On Windows without Git Bash, no hook runs. The startup cost of Git Bash per hook call on Windows is unmeasured.

# SSH Plan: Remote workspace over SSH

Status: Todo

## Goal

Support a workspace hosted on a remote server over SSH, where the agent can edit the workspace files and run commands there.

## Progress

- Goal clarified: this is about remote workspace control over SSH, including file edits and command execution on the server.

## Open Questions

- Exact implementation path is not finalized.

## Dead Ends

- None recorded.

## Notes

One possible shape is a locally visible remote project tree plus SSH-routed command execution, but the core user goal is remote workspace control over SSH.

## Possible hook-based shape

```text
Codex local session
  -> Bash tool call proposed by model
  -> PreToolUse hook receives cwd and tool_input.command
  -> hook maps local cwd to remote cwd
  -> hook rewrites command to ssh -T host 'cd remote_cwd && original_command'
  -> Codex executes rewritten local SSH command
  -> remote shell runs the project command
  -> stdout/stderr return to Codex as normal tool output
```

This is a Codex hook/executor concern. It does not require ACP or bot-level orchestration changes unless the surrounding application wants to generate hook config automatically.

## Required pieces

### 1. Hook configuration

Enable Codex hooks and register a `PreToolUse` hook for the Bash tool.

Use a single hook source to avoid duplicate invocations:

```toml
[features]
hooks = true

[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "python3 /path/to/ssh_rewrite_hook.py"
timeoutSec = 30
statusMessage = "Routing shell command through SSH"
```

The smoke tests proved that interactive Codex can accept `updatedInput.command` from a `PreToolUse` Bash hook.

### 2. Hook input parsing

The hook must read JSON from stdin and extract:

```json
{
  "cwd": "/local/mount/project/subdir",
  "tool_name": "Bash",
  "tool_input": {
    "command": "pnpm test"
  }
}
```

Required fields:

- `cwd`: local working directory where Codex thinks it is running.
- `tool_input.command`: original command proposed by Codex.
- `tool_name`: must be `Bash`.

If the tool is not Bash, or the command is absent, the hook should allow unchanged.

### 3. Local-to-remote path mapping

The hook needs a deterministic mapping from local mounted paths to remote paths.

Example:

```json
{
  "/mnt/devbox/app": "/srv/app"
}
```

If Codex runs in:

```text
/mnt/devbox/app/packages/api
```

the hook maps it to:

```text
/srv/app/packages/api
```

The mapping must reject unmappable paths. Silent fallback to local execution would defeat the purpose of the feature.

### 4. SSH command rewriting

Given:

```text
host = devbox
local cwd = /mnt/devbox/app/packages/api
remote cwd = /srv/app/packages/api
original command = pnpm test
```

the hook should produce:

```bash
ssh -T devbox 'cd /srv/app/packages/api && pnpm test'
```

Implementation should quote the outer SSH command safely:

```python
remote_script = "cd " + shlex.quote(remote_cwd) + " && " + original
rewritten = "ssh -T " + shlex.quote(host) + " " + shlex.quote(remote_script)
```

The original command is intentionally preserved as shell syntax for the remote shell. The hook should quote the remote wrapper, not escape the original into inert text.

### 5. Policy and safety behavior

The hook should enforce routing:

- If cwd maps to a configured remote root, rewrite to SSH.
- If cwd does not map, deny with a clear error.
- If SSH host is missing, deny.
- If command is empty, allow or deny with a clear error.
- Log original command, cwd, mapped cwd, and rewritten command for debugging.

For dangerous commands, keep Codex approval behavior in place. The hook is an execution transport change, not a replacement for command review.

### 6. SSH runtime assumptions

The remote host must provide:

- SSH key or agent auth that works non-interactively.
- Project dependencies installed remotely.
- The same project path as configured in the mapping.
- A shell capable of running Codex-proposed commands.
- Correct environment setup for project commands.

If the remote environment requires profile setup, the remote script may need to run through a login shell, for example:

```bash
ssh -T devbox 'cd /srv/app && bash -lc '"'"'pnpm test'"'"''
```

This should be decided deliberately because login shell behavior can change PATH, aliases, and startup script side effects.

### 7. Output, exit code, and cancellation

Codex should see remote stdout, stderr, and exit status as if they came from a normal local shell command.

Open issues to verify:

- Whether Codex cancellation reliably terminates the local `ssh` process.
- Whether remote child processes terminate on disconnect.
- Whether long-running commands need `ControlMaster`, timeouts, or a wrapper process group.

### 8. Verification plan

Start with command-print smoke tests, then SSH no-op tests, then real project commands.

1. Hook rewrite smoke:

   ```bash
   printf "SHOULD_NOT_EXECUTE\n"
   ```

   Expected output:

   ```text
   printf "SHOULD_NOT_EXECUTE\n"
   ```

2. SSH identity smoke:

   ```bash
   hostname
   ```

   Expected output: remote hostname.

3. SSH cwd smoke:

   ```bash
   pwd
   ```

   Expected output: mapped remote cwd.

4. File visibility smoke:

   ```bash
   test -f package.json && pwd
   ```

   Expected output: remote project path.

5. Real command smoke:

   ```bash
   pnpm test
   ```

   Expected behavior: tests run remotely, output returns to Codex.

## Risks

- Hook behavior differs between interactive Codex and `codex exec`; previous tests showed interactive works, while `codex exec` did not reliably fire hooks.
- Duplicate hook configuration can cause duplicate hook invocations.
- Quoting mistakes can turn safe wrapping into broken or unsafe shell syntax.
- Local file edits and remote command state can diverge if the mount is stale or delayed.
- Remote environment may differ from local assumptions.
- SSH disconnects and cancellation semantics need real testing.

## Minimal implementation path

1. Keep Codex local and project files visible through the existing local path.
2. Add a Bash `PreToolUse` hook.
3. Configure one or more local-root to remote-root mappings.
4. Rewrite mapped commands to `ssh -T host 'cd remote_cwd && original_command'`.
5. Deny unmapped project commands.
6. Log every rewrite.
7. Prove with `pwd`, `hostname`, and one real project command.

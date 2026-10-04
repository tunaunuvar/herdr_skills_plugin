# AI Skills for Herdr

An English, dependency-free Node.js terminal popup for Herdr on Windows, macOS and Linux. Requires Herdr 0.9.0+ and Node.js 18+. User directories and executable locations are discovered at runtime; no machine-specific paths are bundled. Codex is optional; without it, local skill files and installed tools are still listed.

```sh
herdr plugin link .
herdr plugin action invoke open --plugin tunaunuvar.herdr-skills
```

Add this to Herdr's config.toml, then run `herdr server reload-config`:

```toml
[[keys.command]]
key = "f8"
type = "plugin_action"
command = "tunaunuvar.herdr-skills.open"
description = "open AI skills"
```

Alternative Herdr prefix shortcut (Ctrl+B, then Shift+S):

```toml
[[keys.command]]
key = "prefix+shift+s"
type = "plugin_action"
command = "tunaunuvar.herdr-skills.open"
description = "open AI skills and installed tools"
```

The popup shows the current session's Git branch and a summary of staged, modified, deleted, untracked and ahead/behind changes. It runs a read-only local `git status` for the agent's working directory; no fetch, checkout or write operations occur. Non-repository folders are labeled accordingly; remote-only paths or inaccessible folders show Git as unavailable.

Controls: Tab switches between Skills and Tools, Left/Right changes agent/session, `f` cycles filters, `/` searches, `d` shows paths, Up/Down or PageUp/PageDown scrolls, `r` refreshes, `q` or Escape closes. Updates every 30 seconds. The popup initially selects the underlying agent. Names, installation state and observed usage appear in aligned columns with short descriptions below each entry.

The Tools tab discovers a fixed list of common commands on Herdr's PATH, including Graft, AI CLIs, Git, Node.js, npm, Python (including python3), uv, ripgrep and Firebase. Entries are sorted by observed usage and name. **INSTALLED** means the command file exists (and is executable on Unix); its version and successful execution are not inferred. **CALL OBSERVED** means a command invocation was found in the session's tool-call text, with the same limitations as skill read evidence. No commands are executed for discovery. Graft is a CLI/tool, so it appears here even without a SKILL.md.

Labels:

- **ENABLED** / **DISABLED**: enabled/disabled returned by Codex's local `skills/list` API for that working directory. This is current discovery state, not proof that an existing conversation has reloaded the skill.
- **ON DISK**: a local skill file was found, including Codex plugin cache files not returned by the API. It may be an old cached version or belong to an inactive plugin. Enablement is unknown.
- **READ**: an explicit full-path skill read tool call was observed in the exact Herdr-reported agent session's local JSONL transcript. It does not prove the call succeeded, that the instructions were followed, or that the skill is still active in the current turn.
- **NO RECORD**: no matching read call was found. This does not prove non-use: injected skills, relative-path reads, shell aliases, compacted history and remote sessions can lack this evidence.

Supports live Herdr contexts for Codex, Claude Code, OMP and Pi. Codex uses its own app-server for discovery and supplements it with local skills/cache files. Other agents scan shared `.agents/skills`, their user skills directory and project skill directories up to the repository root; their enablement remains unknown. Plugin-provided skills outside these roots are not discovered for those agents. Agents without an adapter are reported rather than guessed. No conversation contents are displayed, and transcripts stay local.

The plugin only reads discovery data and transcripts; it does not change agent settings or install/remove skills. Session evidence is historical for that session. Herdr pane/session identity is used instead of assuming the newest transcript belongs to the focused agent.

```sh
node --check skills.js
node skills.test.js
node skills.test.js --live
node skills.js --json
```

Live checks require the local Herdr server and Codex CLI. Normal tests do not require Graft or a running agent. They cover English labels, responsive layouts, Windows command shims, Unix executable discovery and case-sensitive Unix path matching. The live integration has been verified on Windows; macOS/Linux have not been run end to end in this workspace. Skill descriptions and session titles retain their original language.

References: [Herdr plugins](https://herdr.dev/docs/cli-reference/), [keybindings](https://herdr.dev/docs/configuration/), [Codex skills/list](https://learn.chatgpt.com/docs/app-server#skills).

# Thinktank Studio: full reference

Every feature in detail. For what the app is and how to get started, see the [README](../README.md); for a walk-through, open the help page from the **?** button in the app.

## How it works

| Piece | What it does |
|---|---|
| **Room** | Shared chat. `@claude` / `@codex` / `@grok` targets agents; no mention = everyone. The "Send to" menu sends a private DM, and the agent's reply comes back privately too. |
| **Leader** | Speaks first on broadcasts; owns `PLAN.md` / `tasks.json`; can request phase changes and merges. |
| **Phases** | **Plan** (agents reply one at a time and each sees the others' replies) → **Build** (agents work in parallel in their own worktrees) → **Review** (cross-review branches). Entering Build or Review starts every agent on it; in those phases each turn includes the agent's own tasks from `tasks.json`. |
| **Debate** | Type a topic and click **Debate**: every agent proposes without seeing the others, then all critique each other, then the leader synthesizes into `PLAN.md`. Attached files go to every agent with the question. |
| **Autopilot** | In **Build**, agents keep taking turns until their tasks in `tasks.json` are done. Each one pauses on its own when its tasks are all done or `blocked` (with a `note`), when two turns in a row produce no commit, file change or status change, after 20 turns (`TTS_AUTOPILOT_MAX_TURNS`), or on Stop or an error. When every task is done, the leader is asked to check the branches and request merges. Saved per project, off by default. |
| **Roles** (off by default) | Give each agent a job on the Agents tab: Builder, First reviewer, Final reviewer, Tester, Arbiter or Custom. Each agent is told its role every turn, so a change applies from its next turn. **Saved setups** apply roles, leader, review mode and models in one click. "Starter team" comes pre-made (Claude builds and leads, Grok first review, Codex on `gpt-6-astra` final review), and **Save current…** stores others, e.g. for when an agent is out of usage. When an agent hits a usage limit, a banner offers to switch setups. It never switches on its own. |
| **Review chain** | Top bar → **Review**. *Role chain*: a task its owner marks done goes to the first reviewer, then the final reviewer. Each ends with `[[verdict: approve]]` or `[[verdict: changes]]`, and changes send the task back to its builder with the notes. *Any other agent*: one review by a different agent. **Tests**: an optional command (e.g. `npm test`) that must pass in the builder's copy before a task is accepted. A review that forgets the verdict line is asked once to add it before you're asked. After 3 send-backs a task is marked *stuck* for you to decide. A verdict from an agent that wasn't asked still counts when it names the task (or only one is under review), unless that agent built it or already approved it this round. **Approve**, **Send back** and **Restart** buttons let you override at any point. Progress is saved in `team/reviews.json`. **Accepted work is merged into main automatically** (the commit the reviewers approved), and the branches of tasks waiting on it are brought up to date, so they build on it. When every task is accepted and merged, the project is finished; no Review phase needed. |
| **Line comments** | In **Branches → Diff**, click any line to comment on it. The panel above the diff lists the branch's comments, and **Send N to <agent>** sends every comment that isn't resolved as one change request. The builder ends with `[[fixed: c1, c2]]` for the ones it dealt with; the rest go again next time. You can **Resolve**, **Reopen** or **Delete** any comment. Reviewers can pin comments too, with `[[comment: path/to/file:LINE]] note` in a review. Saved in `team/comments.json`. |
| **Review checkout** | Each review request comes with a throwaway, detached checkout of the builder's branch (`agents/_review-<agent>`), refreshed to the branch tip. The reviewer runs the tests and tries the app there, and is told never to merge or check out the branch in its own worktree. |
| **Project setup (`tts.yaml`)** | Optional, committed in the project repo. `setup:` (one command or a `- list`, run in order) makes a worktree ready, e.g. `npm install`. It runs in each agent worktree and review checkout that has the file, when the commands or a lockfile (`package-lock.json`, `yarn.lock`, `requirements.txt`…) changed since it last succeeded there: so on first use and after a Sync that brought new dependencies. `include:` lists gitignored files (e.g. `.env`) copied from `repo/` into each worktree when missing. `waitForSetup: false` lets turns start without waiting (default: they wait). Output goes to the agent's panel; a failure is posted in the chat and turns go ahead. Env: `TTS_ROOT`, `TTS_WORKTREE`, `TTS_AGENT`. |
| **Resume after restart** | The project that was open reopens. If agents were working (or on autopilot) when the app closed, a banner offers **Continue**: each cut-off agent gets a turn, in its own CLI session, to check its work and finish, autopilot restarts, and interrupted reviews are asked again. Approval requests and questions for you that were still waiting come back too, and a test run that was cut off runs again on its own. `team/backups/` keeps the last 3 good copies of `session.json`, `reviews.json` and `tasks.json`; an unreadable one is restored automatically. |
| **Plan usage** | Each agent's panel shows how much of its plan's 5-hour and weekly limits is used and when they reset, as its CLI last reported (Claude and Codex; Grok doesn't report it). |
| **Merge arbiter** | When merging or syncing hits a conflict, an agent whose work isn't on either side resolves it in a temporary copy, keeping both sides' intent. It prefers the Arbiter role, then the reviewers. The fix is applied only if main is fully merged and no conflict markers remain. Then click Merge again. |
| **Plan check before Build** | Clicking **Build** in Plan, or approving the leader's request to start Build, first shows the plan: every task with its owner, files and "after", the review and test settings, PLAN.md, and warnings (no tasks, tasks without files, file overlaps, an agent with nothing to do). **Start Build**, or, for the leader's request, **Send back** with a note the leader gets. **Reject** on any request asks for a reason too, and the requester gets a turn to act on it. |
| **Merge warning** | Merging a branch whose tasks aren't accepted yet (not done, or not through review) asks you to confirm and lists them. A merge request in the banner shows them too. |
| **Gates** | With **Gates** on, the leader's `[[phase: build]]` request waits in a banner for you to approve or reject, and so does `[[merge: codex]]` for work that wasn't reviewed (reviewed work is merged without asking). Off = applied immediately. |
| **Out of usage / switched off** | When an agent hits a usage limit, it's marked **out until** the reset time in the CLI's message (e.g. "try again at 3:16 AM", "resets in 2h"). If the message gives no reset time (Grok's "try again later"), it stays out until you click **Try now** or message it directly and it answers. Until then it's skipped for turns, reviews and hand-offs, and it rejoins on its own at that time: it takes reviews that waited for it and, in Build with autopilot, resumes its tasks. You can still message it directly to check whether the limit lifted, and **Try now** in its panel clears the mark early. The **On** switch in each agent's panel leaves an agent out completely until you switch it back on. A review whose reviewer is away waits for it. Pick someone else under **Review by** in the Tasks tab, or Approve it yourself. |
| **Hand-offs** | An agent that starts a line with `@other`, or asks `@other` a question, triggers that agent's turn, capped at 6 hops before control returns to you. A name in a list or a plan (`t2 (@codex)`) doesn't, and in Build with autopilot a teammate working through its own tasks is only woken by a question. |
| **Discussion rounds** | In **Plan**, a message to everyone (no `@mentions`) gets up to 3 rounds (`TTS_DISCUSSION_ROUNDS`). After the first round, an agent with nothing new replies `[[pass]]`, which isn't posted. Rounds stop when everyone passes or you send a new message. |
| **Agent DMs** | An agent can start a reply with `[[to: codex]]` to message one teammate privately. The third agent doesn't see it, but you always do. The recipient's reply goes back privately, and `[[pass]]` ends the exchange. Capped at 4 private messages per message from you. |
| **Ask and wait** | An agent that needs something from a teammate before it can go on starts its reply with `[[ask: codex]]` and the question. The question goes privately to Codex (you see it; the third agent doesn't), and the asker's autopilot holds. Codex's next reply is the answer: it goes back to the asker, whose next turn starts with it. If Codex can't answer (it passes, is stopped, or its turn fails), or there's no answer in 15 min (`TTS_ASK_TIMEOUT_MIN`), the asker is told and carries on. Each question is sent once, and there are up to 4 per message from you. The Agents tab shows "waiting for Codex's answer". |
| **Needs you** | An agent that writes `@user` (a question or a decision only you can make) gets a banner at the top of the chat, with **Reply** and **Dismiss**, and a count in the browser tab title. It clears when you message that agent. |
| **Errors** | Failures are sorted into plain-language messages with the fix: not signed in (`grok login`), usage limit, unknown model, CLI not installed, conversation too long (starts fresh automatically), or network. |
| **Context** | Claude, Codex and Grok resume their own sessions, so each turn sends only new messages. Generic CLIs get the last 40. If a session can't be resumed, the agent starts a fresh one with the recent chat; nothing is lost. |
| **Stop / stalls** | Stop kills the running turn and drops anything queued for that agent; Stop all also ends a debate. Instead of a fixed timeout, a watchdog flags a turn that may be stuck: no output for 6 min (`TTS_STALL_QUIET_MIN`), or 30 min for an agent on a model server (`TTS_STALL_SERVER_MIN`) since local models are slow, or the agent's own **Stuck warning after (min)** from Setup → Agents; 2 min while running a command that usually never exits such as `npm run dev` or a watcher (`TTS_STALL_LONGRUN_MIN`), or the same command 4 times in a row. A banner offers **Keep waiting** (asks again later), **Nudge** (stops the turn and starts a new one telling the agent why, so it continues another way), or **Stop**. Anything the agent said before being cut off is kept and posted, including a review verdict. A turn is only stopped automatically at 120 min (`TTS_TURN_TIMEOUT_MIN`). |
| **Local models** | Setup → Agents → a Codex CLI agent with a **Model server** address (LM Studio, Ollama, llama.cpp; on this computer or another one on your network, e.g. `http://192.168.1.50:1234/v1`) and the model's name runs that model through Codex: same resume, live tool use and token counts. The server must offer the OpenAI Responses API (`/v1/responses`); give the model at least a 32k context. Local models are slow, so these agents wait **30 min** without output before the stuck warning (change it per agent in **Stuck warning after**). Steps in the help page, *Local models*. |

### Side panel

Hover over any button, menu or label for a plain-language explanation.

- **Agents:** live activity (saved in `team/activity/`, so it's still there after a reload), Stop, and per-agent **model**, **effort** and **autonomy** pickers (saved per project, applied from the next turn).
- **Plan:** `team/PLAN.md`, updated live; click Edit to change it yourself.
- **Tasks:** `team/tasks.json` as a table (id, title, owner, files, status, after, review, note).
- **Branches:** commits ahead/behind main, uncommitted work, and a **will conflict** warning (dry-run merge) for each agent. **Diff** shows exactly what a merge would bring in (per-file, collapsible), plus any uncommitted edits. **Merge** puts a branch into main. **Sync** merges main into a branch. On a conflict the merge is aborted, the files are listed, and Sync asks that agent to resolve and commit.

### Images and files

Both chats take images and text files: click 📎, paste, or drag files onto the chat. They upload right away and show as thumbnails (images) or 📄 chips (files) that you can remove before sending.

- **Images:** PNG, JPG, GIF, WebP, up to 10 MB.
- **Text files, up to 2 MB:** `.txt .md .log .json .jsonl .csv .tsv .yaml .yml .toml .ini .xml .html .css .scss .js .mjs .cjs .jsx .ts .tsx .py .rb .go .rs .java .kt .c .h .cpp .hpp .cs .swift .php .sh .bash .zsh .ps1 .sql .diff .patch .pine`. The app checks the file really is plain text, and the browser always shows these as plain text, never runs them. No PDFs.
- **Who sees them:** a file goes to whoever the message goes to. A private message's file goes to that one agent only. Files are saved in the project's `team/attachments/`, or in `~/.thinktank/attachments/` for the helper.
- **Sent once:** a file is sent with the message it's attached to, not re-sent on every later turn.
- **Which agents can open them:**
  - **Text files:** every agent reads them from the path it's given. Checked with the real Claude CLI on a `.pine` file.
  - **Images:** Claude opens the image file (checked with the real CLI). Codex gets it through its `--image` option. Grok gets the path and opens it with its file tool (checked with the real CLI: it read the text, colors and shapes in a test image).

### Done reports and attempts

When a builder finishes a task, it ends its reply with `[[done: t3#2 | done | one-line summary]]`. It uses `| blocked | why` or `| partial | what's left` when it can't finish.

- **The app applies it to tasks.json itself**, so the report counts even if the agent forgot to edit the file. It also uses the summary as the hand-off note if there isn't one.
- **Checked against git before it counts.** A "done", whether reported or written straight into tasks.json, starts review, is accepted or releases dependent tasks only after the app checks it, when the builder's turn ends. It needs commits of the builder's own on its branch: in the task's files (or anywhere if the task has none), and since the send-back for a later attempt. Teammates' work brought in by Sync or a merge doesn't count. Otherwise the task goes back to "doing" with a note saying why.
- **Attempts.** Each task starts at attempt 1 and goes up every time it's sent back. A report quoting an older attempt is ignored. A "done" written by a turn that was already running when the task was sent back reopens the task, and autopilot carries on with the fix. A report for another agent's task is ignored too. Attempts are saved in `team/session.json`.
- **One-click answers.** An `@user` question can offer choices with `[[options: A | B | C]]`. They show as buttons on the needs-you banner, and clicking one answers that agent privately.

### File areas

Each task in `tasks.json` can claim the files it owns:

```json
{ "id": "t1", "title": "REST API", "owner": "claude", "status": "todo", "files": ["src/api/**", "package.json"] }
```

`**` matches any depth, `*` matches within one folder, and a plain folder name covers everything inside it. The leader is told to give each agent its own area, with shared files like `package.json` under exactly one owner.

- **Overlaps:** when two agents' tasks could claim the same files, you get a warning in chat and in the Tasks tab. Patterns are compared folder by folder, so `tsconfig*.json` and `src/engine/**` don't overlap. Tasks that are done, or that come `after` one another, aren't checked against each other (they don't run at the same time). Each overlap is announced once; editing tasks.json only reports new ones.
- **Edits outside an agent's area:** after each Build turn, the app checks which files the agent changed: its own commits not yet in main, plus uncommitted edits. Teammates' work it merged into its branch doesn't count. If it touched another agent's files, or files none of its own tasks claim, you're told, and the agent is asked to undo the change or ask the owner. The Branches tab shows an **outside its area** count; hover it for the list.
- Tasks without `files` are not checked.

### Task order and hand-offs

A task can wait for others with `"after"`, and the builder leaves a `"handoff"` note when it's done:

```json
{ "id": "t2", "title": "UI", "owner": "grok", "status": "todo", "after": ["t1"] }
{ "id": "t1", "title": "API", "owner": "claude", "status": "done", "handoff": "GET /items returns JSON; see src/api/routes.ts" }
```

- A task is **ready** once every task it comes after is accepted: done, and through review if review is on.
- Agents whose open tasks are all waiting sit out of Build and autopilot. When the task they wait on is accepted, they start automatically, with that task's hand-off note in their instructions. Reviewers see the hand-off too.
- The Tasks tab has an **After** column (*waiting* / *ready*), and a 📝 on the title when there's a hand-off note (hover to read it). An `after` id that doesn't exist shows with a `?` and is ignored.

### Usage

Each agent's panel shows its token count and turns, and the header shows the project total. Hover for the in/out/cached breakdown and the API-price equivalent the CLIs report (Claude and Grok; Codex reports tokens only). On subscription logins that dollar figure is not your bill, which is why tokens come first. ↺ resets the counters.

**Theme:** the switch at the top right picks System, Light or Dark; your browser remembers the choice.

### Autonomy levels

| Level | Claude Code | Codex | Grok Build |
|---|---|---|---|
| Read-only | `--permission-mode plan` | `--sandbox read-only` | `--permission-mode plan` |
| Edits + dev commands (default) | `acceptEdits` + allowed commands | workspace sandbox (see below) | `acceptEdits` + allowed commands |
| Auto | `--permission-mode auto` | `--approve-for-me` + workspace sandbox | `--permission-mode auto` |
| Full access | `bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` | `--yolo` |

**Codex at Edits and Auto** runs in Codex's own workspace sandbox through a permissions profile the app passes on the command line (`-c default_permissions="tts-agent"`; nothing is written to your `~/.codex`). It extends Codex's `:workspace` profile with write access to the team folder and the parts of the shared `.git` a commit needs (`worktrees/<agent>`, `objects`, `refs`, `logs`), never `hooks/` or `config`. Plain `--sandbox workspace-write` keeps a worktree's `.git` read-only, so Codex agents could edit but not commit. On Windows the app also trusts the agent's folders for git (Codex's sandbox runs commands as a separate user, which git calls "dubious ownership") and removes the leftover "deny write" entries Codex's sandbox puts on `.git/worktrees/<agent>` and never removes (only Codex's own entries, for its unnamed sandbox SIDs; a deny you set for a named user or group is kept). Git 2.45 may print `Unable to create '…/packed-refs.lock'` after a sandboxed commit; the commit still succeeds. If your Codex config sets `sandbox_mode`, Codex ignores permissions profiles: remove that line so Codex agents can commit.

**Hermes Agent** has no permission modes; the levels pick its toolsets instead. Read-only: `file,web,session_search,todo,skills,vision` (no shell, but its file tool can still write, so it isn't truly read-only). Edits and Auto: adds `terminal,code_execution,memory`. Full access: all of your Hermes toolsets plus `--yolo`. Below full access, desktop control, the browser, scheduled jobs, sub-agents and messaging are left out. Its model list and default model come from Hermes's own config (`config.yaml`, `provider_models_cache.json` in `HERMES_HOME`). Sign in with `hermes model`. A Hermes session keeps the model, effort and level it started with, so after you change one the next turn starts a new Hermes session (it gets the recent chat). Known limit: Stop ends the app's connection, but Hermes's gateway finishes the running turn in the background.

At the "edits" level, agents may run `git`, `npm`/`npx`/`pnpm`/`yarn`, `node`, `python`/`pytest`/`pip`, `cargo`, `go` and `make` without asking (headless CLIs silently deny anything else). Override per agent with `"allowCommands": [...]` in `agents.config.json`.

Each agent can also write to the shared `team/` folder and the parts of `repo/.git` that committing from a worktree needs (`objects`, `refs`, `logs`, its own `worktrees/<id>`), not hooks or config. Claude gets these through `--add-dir`, Codex through its permissions profile (Read-only and Full access: `--add-dir`); Grok uses `--allow "Read(<dir>/**)"` and `"Edit(<dir>/**)"` rules.

### Project layout (`~/ThinktankProjects/<name>`, override with `TTS_PROJECTS_DIR`)

```
repo/           main branch: merges land here
agents/<id>/    git worktree per agent on branch agent/<id>
team/           PLAN.md, tasks.json, chat.jsonl, session.json (shared, not in git)
```

## Configuring agents: `agents.config.json`

| adapter | CLI invocation |
|---|---|
| `claude` | `claude -p --output-format stream-json --verbose [--model m] [--effort e] [--resume id]`, prompt on stdin |
| `codex` | `codex exec --json [-m m] [-c model_reasoning_effort="e"] [resume <thread_id>] -`, prompt on stdin |
| `grok` | `grok --prompt-file <tmp> --output-format streaming-json --cwd <worktree> [-m m] [--effort e] [-r id]` |
| `hermes` | `hermes chat --query-file - --format stream-json --source tool --in <worktree> [-m m] [--reasoning e] [--resume id]`, prompt on stdin |
| `generic` | any one-shot CLI; `{prompt}` in `args` is replaced, otherwise the prompt goes to stdin |

Optional fields: `model`, `effort` and `autonomy` (the defaults for the pickers, marked "(default)" there; picking default or leaving a project's setting empty uses them), plus `args` (extra flags appended every turn).

**Model lists come from the CLIs.** Codex and Grok keep their own model lists on disk (`~/.codex/models_cache.json`, `~/.grok/models_cache.json`, refreshed by the CLI). The pickers read those, so a model added by a CLI update shows up without changing the app. The effort menu only lists the levels the chosen model accepts, and switching to a model that doesn't accept the current effort resets it. Claude, and any CLI whose list can't be read, falls back to the list in `server/agents/catalog.ts`. **Other model id…** takes any id by hand. Every turn tells the agent which model and effort it's running on.

## App helper (fixing or changing the app itself)

The **Helper** tab is a private chat with Claude about the app itself, not your projects. Ask what something does, why something isn't working, or for a new feature. Problem messages in the room have an **Ask helper** button that opens the tab with the error filled in.

What the helper sees, so you don't have to copy anything over:
- **With every message:** the server log, problems the app showed you, and each agent's recent activity: tool calls, CLI output such as "not logged in", and why a turn failed.
- **When it needs to:** the open project's folder, read-only. That covers the main code, each agent's working copy, the plan, the tasks, the full team chat and the activity history. It can never change your project.
- **Not your screen:** errors that only happen in the browser aren't visible to it. Describe what you see.

- **Read-only by default.** Tick **Allow edits** to let it change code. It works in its own copy of the app's source (a git worktree on branch `app-helper`, under `~/.thinktank/`), so nothing changes in the running app yet.
- **Apply & restart** typechecks the changes, merges them into the app and restarts it. If agents are mid-turn, it asks first. **View changes** shows the diff first, and **Discard** throws the changes away.
- **Safety nets:**
  - A change that fails the typecheck is not applied; the errors go back to the helper.
  - If the app crashes on startup after an update, the supervisor rolls it back automatically and the helper tells you.
  - **Undo last update** returns to the previous version.
- **When the app won't start at all**, the helper can't help, because it lives inside the app. Open a terminal in the app folder and run `claude`, or start a Claude Code session on this repo.
- The helper uses Claude Code by default; change it with a `"helper": { "adapter": "claude", "command": "claude", "model": "...", "effort": "..." }` entry in `agents.config.json`.
- It needs the app folder to be a git clone (it is if you used `git clone`). Without git it can only read and explain.

### Run my project (the helper babysits a project)

Tick **Run my project** and the helper keeps the open project moving while you're away. When something waits on you, it looks about 45 seconds later (so you can act first if you're there) and handles what it can:
- **Approves or rejects** the leader's phase and merge requests, by your brief and the plan.
- **Answers an agent's @user question** only when the answer follows from what you already said or the plan. Real decisions stay in the banner for you.
- **Nudges a stalled agent**, continues after a restart, and restarts an agent left idle with tasks.

Every step it takes shows in the Helper tab as a ✓ line, and each one goes through the same action as the button you'd click. It never edits files, changes scope or settings, or deletes anything. It runs at most 8 automatic checks an hour to protect your usage. With it on, you can also tell it in chat to act ("approve Claude's request").

## Security

The server binds to `127.0.0.1` and only accepts WebSocket connections from its own page (same port), because agents can edit files and run commands. Don't expose it to a network without adding authentication.

- The app's own git commands run with hooks disabled, so an agent can't plant a `.git/hooks` script that runs when you click Merge.
- Autonomy levels limit which tools each CLI will use. They are not a full sandbox. An agent allowed to run `git` can still reach the shared repository, for example by resetting `main`. Review diffs before merging, and use Read-only for agents you don't trust with a task.

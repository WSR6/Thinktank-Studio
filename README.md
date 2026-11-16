# Thinktank Studio

**AI coding agents from different companies, working as one team.** Claude Code, Codex, Grok, Hermes and local models plan together, debate the approach, build in parallel, and review each other's work, all in one chat that you run.

<!-- Screenshot: the main window with a project in Build (chat on the left, agent panels on the right). -->

## What it is

Thinktank Studio is a local web app (for now) that runs the AI coding tools you already use, each through its own command-line program and its own login, and makes them work together on one project:

- **Plan together.** Agents read each other's replies and agree on a plan and a task list.
- **Debate.** Ask a question and every agent proposes an answer without seeing the others, then they critique each other, then the leader writes up the result.
- **Build in parallel.** Each agent works in its own copy of the project (a git worktree on its own branch), on the tasks it owns.
- **Review each other.** A task one agent finishes is checked by another, from a different company, before it's merged. Reviewers can send work back with notes or line comments.
- **Merge.** Approved work goes into main automatically, and the agents waiting on it pick it up.

You choose who leads (yourself or any agent), which agent does what, how much each one may do on its own, and when to move from planning to building. The app does the coordinating, the bookkeeping and the git work.

## What makes it different

- **Mixed teams, not one model talking to itself.** Models from different companies have different strengths and different blind spots. Here they check each other's work, so one model's mistake is more likely to be caught by another.
- **Your existing subscriptions.** Each agent runs through its own CLI with its own login (Claude, ChatGPT, Grok plans and so on). No API keys needed, and no new account.
- **Local models as team members.** An agent can run on a model served from your own hardware (LM Studio, Ollama, llama.cpp), on this computer or another one on your network.
- **Built to run on its own.** Autopilot keeps agents working through their tasks; a watchdog flags a stuck agent; agents out of usage step aside and rejoin when their limit resets; an optional helper can approve routine requests while you're away. It stops for you only for real decisions.
- **Everything stays on your computer.** Projects, chat history and code live in a folder on your disk, in plain files and git.

## Why I made it

I used to write programs with the Claude desktop app and have Grok and Codex review the code: Grok as the first reviewer, Codex as the final one, and either could send work back for fixes. That worked, but the reviewers found errors often enough that I knew relying on one agent alone wasn't a good idea.

Then I realized that even with reviewers, the code, the ideas and the direction were all coming from one agent. So I wanted every agent to put forward ideas, debate each other on why one approach is better than another, and agree together on the best way to build something. After that, each one could take a slice of the work, which speeds things up while keeping the same strong reviews, and with more than one perspective on direction. I can lead the team however I want, or let one of the agents be the team lead.

Last, I wanted a helper that could run the app for me while I'm busy or at work, and that could also look into any errors and answer my questions about the app itself while it's running.

Those are the main reasons I wanted this app, and I couldn't find anything else that did all of it.

## Supported agents

| Agent | How it runs | Status |
|---|---|---|
| **Claude Code** | `claude` CLI | Fully supported, used daily |
| **Codex** | `codex` CLI | Fully supported, used daily |
| **Grok Build** | `grok` CLI | Fully supported, used daily |
| **Hermes Agent** | `hermes` CLI | Supported (see known problems) |
| **Local models** | Codex CLI pointed at a model server (LM Studio, Ollama, llama.cpp) offering the OpenAI Responses API | Works; tested with LM Studio. Results depend heavily on the model |
| **Any other CLI** | The `generic` adapter: any program that takes a prompt and exits (OpenCode, Pi, aider…) | Works, with fewer features: no session resume, no live tool activity |

Add, remove and configure agents in the app under **Setup → Agents**: any number of them, not just three.

## Getting started

You need:
- **Node.js 20 or newer** and **git**
- At least two of the agent CLIs above, installed and signed in (`claude`, `codex`, `grok`…)

```bash
git clone <this repository>
cd Thinktank-Studio
npm install
npm run mock      # try the app with fake agents first: no CLIs or usage needed
npm start         # the real thing: open http://localhost:4317
```

To start it from anywhere with the `ttstudio` command, run `npm link` once in the app folder.

Then, in the app:
1. **Create a project** (top left). It gets its own folder in `~/ThinktankProjects/`.
2. Describe what you want in the chat. In **Plan**, the agents discuss it and the leader writes `PLAN.md` and a task list.
3. Click **Build**. You see the plan and the tasks first; start it, and each agent works on its own tasks.
4. Finished tasks are reviewed by another agent and merged into main. You can step in at any point: approve, send back, comment on lines, or take over.

The **?** button in the app opens a full help page, written for first-time users. Every feature is described in detail in [docs/reference.md](docs/reference.md).

**Platforms:** developed and used daily on Windows 11. macOS and Linux should work (nothing in the app is Windows-only) but are tested less.

## Costs and usage

Thinktank Studio itself is free and needs no account. Each agent uses your own plan with its company, and a team uses more of it than one agent alone: several agents work at once, and reviews and debates add turns. The app shows each agent's token use and, for Claude and Codex, how much of the plan's 5-hour and weekly limits is used. An agent that runs out is taken out of turns until its limit resets.

## Safety

Agents edit files and run commands on your computer. The app limits what they can do with each CLI's own permission settings (Read-only, Edits + dev commands, Auto, Full access, chosen per agent), but these are not a complete sandbox.

- The app only listens on `127.0.0.1` (this computer) and only accepts its own page. Don't expose it to a network.
- Each agent works in its own copy of the project. Nothing reaches main until it's reviewed (or you merge it), and the app's own git commands run with git hooks turned off.
- Read diffs before merging work you care about, and use Read-only for an agent you don't trust with a task.

## Current problems

Known problems and limits, so they don't surprise you:

- **Usage adds up.** Several agents plus reviews use your plans' limits much faster than one agent does, on a single provider.
- **Local models can be slow and less reliable.** A step can take minutes. Small models may not use their tools at all, and some claim work they didn't do (the app checks git and keeps such a task open). The server must offer the Responses API, and the model needs a context window of at least 32k.
- **Codex on Windows:** if your Codex uses its "elevated" Windows sandbox, it asks for administrator rights once to set itself up. Git may print a harmless `packed-refs.lock` warning after a sandboxed commit.
- **Hermes Agent:** Stop disconnects from the turn, but Hermes finishes it in the background.
- **Grok** doesn't report its plan's usage limits, so its panel shows tokens only.
- **Attachments** are images and plain-text files only: no PDF or Word documents yet.
- **The generic adapter** sends recent chat with every turn instead of resuming a session, and shows no live tool activity.
- **Permission levels are not a sandbox.** An agent allowed to run `git` could still reach the shared repository.
- **Little testing on macOS and Linux** so far.

## To do

- PDF and Word attachments
- Full adapters (session resume, live activity, model picker) for more agents: OpenCode, Pi, DeepSeek and others
- Agents running on another computer on the network, not just the model
- A ready-made local-model setup with Ollama, tested on a GPU machine
- Desktop testing with a real mouse and keyboard for apps that need it
- Easier install: a single download, no Node.js setup
- More testing on macOS and Linux

## Feedback

Bug reports and ideas are welcome in GitHub Issues. Include what you did, what you expected, and the error text the app showed; the **Helper** tab in the app can explain most errors and suggest a fix.

## License

MIT. See [LICENSE](LICENSE).

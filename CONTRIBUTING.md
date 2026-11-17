# Contributing to Thinktank Studio

Thanks for wanting to help. Bug reports, ideas and fixes are all welcome.

## Questions and ideas

- **Questions, ideas, "how do I…"**: start a thread in [Discussions](../../discussions).
- **Something broken**: open an [Issue](../../issues/new/choose) with the bug report form. Say which agents (Claude Code, Codex, Grok…) and which operating system you used, and what you saw.

## Sending a fix or a feature

1. Fork the repository and make a branch for your change.
2. Install and try it:
   ```bash
   npm install
   npm run mock        # fake agents: no CLIs or usage needed
   npm run typecheck   # must pass
   ```
   If your change touches a real agent (Claude Code, Codex, Grok, Hermes), please also try it with that CLI and say so in the pull request.
3. Keep each pull request to one change. Small ones get merged faster.
4. In the pull request, say what it fixes or adds, how you tested it, and on which operating system.

## How changes are reviewed

Every pull request is reviewed before it is merged, including by AI agents (Grok and Codex) as a first pass, then by the maintainer. You may get questions or requested changes; that's normal.

## Things to keep in mind

- **Safety first.** Agents run commands on people's computers. Changes that loosen agent permissions or the sandbox need a clear reason.
- **Plain words in the app.** Help text and banners are written for first-time users: short sentences, no jargon.
- **No personal data** in code, docs, screenshots or examples.

By contributing you agree your work is released under the [MIT License](LICENSE).

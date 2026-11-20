/**
 * The text the app sends to agents: the first-turn preamble, and the instructions for build, review,
 * send-back, arbitration, questions, nudges and debate rounds. Pure functions: everything they need
 * (names, attempts, hand-off notes) is passed in.
 */
import { effectiveModel } from '../agents/models.js';
import { isMachineStage, STAGE_LABELS, type ReviewEntry, type StageKind } from '../reviews.js';
import type { ProjectInfo } from '../project.js';
import type { AgentConfig, AgentSettings, Phase } from '../types.js';
import type { Task } from './types.js';

type NameOf = (id: string) => string;

/** Sent on Continue after a restart to each agent whose turn was cut off. */
export const RESUME_NOTE =
  'RESUMED: the app was closed or restarted in the middle of your last turn, so that turn was cut off and its reply was lost. ' +
  'Check your worktree first (git status, git log -3) to see how far you got, then finish what you were doing and report as usual. ' +
  "Don't redo work that's already committed.";

/** The first prompt of a conversation: who it is, the project, the team files and the chat markers. */
export function preamble(cfg: AgentConfig, others: string, p: ProjectInfo): string {
  return `You are ${cfg.name} (@${cfg.id}), one agent in a team chat with the user and ${others}.

Project: ${p.name}
- Your working directory is your own git worktree on branch agent/${cfg.id}. Only edit files there.
- Shared team files (not in git): ${p.teamDir}/PLAN.md and ${p.teamDir}/tasks.json.
  tasks.json format: {"tasks":[{"id":"t1","title":"...","owner":"<agent id>","status":"todo|doing|done|blocked","files":["src/api/**"],"after":["t0"],"handoff":"...","note":"optional, e.g. why blocked"}]}
  "after" lists tasks that must be accepted first; don't start a task until they are. When you mark a task done,
  add a short "handoff": what you built, files changed, and key decisions. Whoever builds on it, and reviewers, read it.
  Also end that reply with [[done: <task id>#<attempt> | done | one-line summary]] (attempt is given in your instructions;
  use "| blocked | why" or "| partial | what's left" when you can't finish). The app checks it against your branch.
  "files" lists the paths a task owns (repo-relative; ** = any depth). When planning, the leader gives each
  agent separate areas and puts shared files (package.json, routers, shared types) under exactly one owner.
- Main branch lives at ${p.repoDir}. The user merges agent branches there from the app.

Rules:
- PLAN phase: discuss and critique; don't write code. Only the leader edits PLAN.md and tasks.json.
- BUILD phase: work only on tasks you own, commit to your branch, update your task status. If you're stuck, set the task to "blocked" with a "note".
  Only edit files inside your tasks' "files". If you need a change in a file another agent owns, @mention them and ask.
  With autopilot on you'll get repeated turns until your tasks are done or blocked, so keep each reply short.
- REVIEW phase: review teammates' branches (git log/diff main..agent/<id>) and report issues.
- Keep chat replies concise; put long detail in files. To hand work to a teammate, start a line with @id (or ask @id a question); naming someone in a list or a status update doesn't wake them.
- If you have nothing new to add, reply exactly [[pass]] (it isn't posted).
- To message one teammate privately (the user still sees it), start your reply with [[to: <id>]]. Use it for FYI notes, not for doing work out of sight.
- To ask a teammate something you need before you can continue, start your reply with [[ask: <id>]] and the question. Your turn ends there; their answer arrives as your next turn (or a note if they can't answer). Ask once; don't repeat the question.
- If you need a decision or information only the user can give, write @user with your question; the app flags it for them.
  If there are clear choices, add [[options: choice A | choice B | choice C]] and the user can answer with one click.
- If you are the leader: when planning is complete, end your reply with [[phase: build]]. Don't ask the user whether to start building; the marker is how they approve it, in one step.
  Work that passes review is merged into main by the app; you don't need to request it. Only for work that wasn't reviewed, ask with [[merge: <agent id>]].`;
}

/** Tells the agent which model and effort it runs on; the CLIs don't, so agents can't answer "what model are you?". */
export function modelLine(cfg: AgentConfig, settings: AgentSettings): string {
  if (cfg.adapter === 'mock' || cfg.adapter === 'generic') return '';
  const { model, effort } = effectiveModel(cfg.adapter, settings.model, settings.effort, cfg.server, settings.profile);
  return `[you are running on model: ${model} | reasoning effort: ${effort}]`;
}

/** The system line when the phase changes. */
export const PHASE_HINT: Record<Phase, string> = {
  plan: 'Discuss and refine PLAN.md. No code yet.',
  build: 'Each agent builds its assigned tasks from tasks.json in its own worktree and commits to its branch.',
  review: "Review each other's branches. Leader merges approved work into main.",
};

/** The first turn of BUILD or REVIEW. */
export function phaseStartInstruction(phase: 'build' | 'review'): string {
  return phase === 'build'
    ? 'BUILD phase has started. Work on the tasks you own in tasks.json: set them to "doing", implement them in your worktree, commit, then set them to "done". Reply briefly with what you finished or what blocks you.'
    : "REVIEW phase has started. Review your teammates' branches (git log/diff main...agent/<id>) and report concrete issues. Don't edit their code.";
}

/** Autopilot's next turn on a task; `handoffs` are the notes of the tasks it builds on. */
export function continueInstruction(t: Task, attempt: number, handoffs: string): string {
  return (
    `AUTOPILOT: keep going. Next unfinished task: ${t.id} "${t.title ?? ''}" [${t.status ?? 'todo'}]. ` +
    'Implement it, run the relevant tests, commit, and set its status to "done" in tasks.json with a short "handoff". ' +
    `Then end your reply with [[done: ${t.id}#${attempt} | done | one-line summary]] (or "| blocked | why" if you can't finish). ` +
    'If you cannot proceed without a decision or a teammate\'s work, set its status to "blocked" with a "note" saying why. ' +
    'Reply with one or two lines of progress.' +
    (handoffs ? `\n\nThis task builds on:\n${handoffs}` : '')
  );
}

/** The leader's turn once every BUILD task is done (and not all of it could be merged by the app). */
export const ALL_DONE_LEADER_INSTRUCTION =
  'All BUILD tasks are done. Check each teammate\'s branch (git log/diff main...agent/<id>), then request merges with [[merge: <id>]] for the ones that are ready, and [[phase: review]] when done.';

/** A review request for one stage of a task. `checkout`: the throwaway copy of the builder's branch. */
export function reviewInstruction(t: Task, stage: StageKind, rec: ReviewEntry, nameOf: NameOf, handoff: string, checkout?: string): string {
  const owner = t.owner ?? '';
  const earlier = rec.history
    .filter((h) => h.verdict === 'approve' && !isMachineStage(h.stage))
    .slice(-2)
    .map((h) => `- ${nameOf(h.by)} (${STAGE_LABELS[h.stage]}) approved: ${h.notes.slice(0, 600)}`)
    .join('\n');
  const files = Array.isArray(t.files) && t.files.length ? ` It owns: ${(t.files as string[]).join(', ')}.` : '';
  return [
    `REVIEW REQUEST (${STAGE_LABELS[stage]}): task ${t.id} "${t.title ?? ''}", built by ${nameOf(owner)} on branch agent/${owner}.${files}`,
    `Look at the work with \`git diff main...agent/${owner}\` and \`git log main..agent/${owner}\` (run them in your worktree; branches are shared).`,
    checkout
      ? `Their branch is checked out at ${checkout} for you: install, build, run the tests and try it there (for UI work, launch it and look). ` +
        "It's a throwaway copy: don't commit there, and never merge or check out their branch in your own worktree."
      : "Don't merge or check out their branch in your own worktree; read it with git diff/show.",
    'Run the tests rather than only reading the code. To point at a specific line, add a line [[comment: path/to/file:LINE]] your note (LINE in the new version).',
    stage === 'final'
      ? 'You are the final check before this task is accepted. Be strict: look for what the builder and the first reviewer missed.'
      : 'Check that it works, matches PLAN.md and the task, handles edge cases, and has tests where it should.',
    handoff ? `The builder's hand-off note: ${handoff}` : '',
    earlier ? `Earlier reviews:\n${earlier}` : '',
    "Don't edit their code. End your reply with exactly one line: [[verdict: approve]] if it's ready, or [[verdict: changes]] followed by a numbered list of the changes required.",
  ]
    .filter(Boolean)
    .join('\n');
}

/** The reviewer's reply had no verdict line: ask once for just the verdict. */
export function verdictReaskInstruction(taskId: string, stage: StageKind): string {
  return (
    `Your review of ${taskId} (${STAGE_LABELS[stage]}) ended without the verdict line, so the app couldn't record it. ` +
    "Don't redo the review: reply with your conclusion in a sentence, ending with exactly one line: " +
    '[[verdict: approve]] if it is ready, or [[verdict: changes]] followed by a numbered list of the changes required.'
  );
}

/** A verdict that could be for several tasks: ask which one. */
export function whichTaskInstruction(candidates: string[]): string {
  return (
    `Your verdict could be for ${candidates.join(', ')}, so the app couldn't record it. ` +
    "Don't redo the review: reply with [[verdict: approve]] or [[verdict: changes]] plus the task id it is for. " +
    'Put the id in the marker, for example [[verdict: approve t16]] or [[verdict: changes t16]].'
  );
}

/** The builder's turn after a review (or the tests) asked for changes. */
export function sendBackInstruction(t: Task, who: string, attempt: number, notes: string): string {
  return (
    `CHANGES REQUESTED on ${t.id} "${t.title ?? ''}" by ${who} (attempt ${attempt}):\n${notes.slice(0, 4000)}\n\n` +
    `Make these changes, run the tests, commit, and set ${t.id} back to "done" in tasks.json. ` +
    `End your reply with [[done: ${t.id}#${attempt} | done | what you changed]].`
  );
}

/** The new builder's turn after you moved a task to it. */
export function newOwnerInstruction(t: Task, fromName: string, fromBranch: string, attempt: number): string {
  return (
    `${t.id} "${t.title ?? ''}" is now yours: the user moved it from ${fromName} to you.${fromBranch}` +
    `Finish it, then end your reply with [[done: ${t.id}#${attempt} | done | one-line summary]].`
  );
}

/** "Send to builder": the open line comments on its branch. */
export function commentsInstruction(agent: string, described: string[]): string {
  return (
    `CHANGES REQUESTED (line comments on your branch agent/${agent}):\n${described.join('\n')}\n\n` +
    'Address each one, run the tests and commit. Then add a line [[fixed: c1, c2]] listing the comments you dealt with; ' +
    "for any you disagree with, say why instead of listing it. Unlisted ones are sent again next round."
  );
}

/** A neutral agent's job: merge main into a copy of the branch and resolve the conflicts. */
export function arbitrationInstruction(o: { id: string; name: string; sides: string; files: string[]; branch: string; teamDir: string; testCommand: string }): string {
  return [
    `ARBITRATION: branch agent/${o.id} (${o.name}) conflicts with main (${o.sides}) in: ${o.files.join(', ')}.`,
    `This folder is a copy of agent/${o.id} on branch ${o.branch}. Run \`git merge main\`, then resolve every conflict keeping what BOTH sides intended.`,
    `Learn each side's intent first: \`git log main..agent/${o.id}\`, \`git log agent/${o.id}..main\`, and the tasks in ${o.teamDir}/tasks.json. Don't simply pick one side.`,
    o.testCommand ? `Then run \`${o.testCommand}\` and fix anything the merge broke.` : 'Then check the result builds and works.',
    'Commit the merge (no conflict markers left), and reply with a short summary naming each decision you made.',
  ].join('\n');
}

/** The prompt of a standalone job (see OneShot). */
export function oneShotPrompt(cfg: AgentConfig, projectName: string, model: string, instruction: string): string {
  return [
    `You are ${cfg.name} (@${cfg.id}), working for a team of AI agents and the user on project "${projectName}".`,
    model,
    'This is a standalone job in its own folder (your working directory), separate from your usual worktree.',
    instruction,
  ].join('\n\n');
}

// ── Questions between agents ──────────────────────────────────────────

export function questionInstruction(fromName: string, askId: string, question: string): string {
  return (
    `QUESTION from ${fromName} (${askId}), who is waiting for your answer before continuing:\n${question.slice(0, 4000)}\n\n` +
    'Answer it directly and concisely in this reply; it goes back to them. Say plainly if you cannot answer.'
  );
}

export function answerInstruction(byName: string, askId: string, answer: string): string {
  return answer
    ? `ANSWER from ${byName} to your question (${askId}):\n${answer.slice(0, 6000)}\n\nContinue your work with this.`
    : `${byName} couldn't answer your question (${askId}). Continue without it, ask someone else, or ask the user (@user).`;
}

/** The question can't be answered (its target stopped, failed or is away): `why` completes "X couldn't answer … : why". */
export function noAnswerInstruction(byName: string, askId: string, why: string): string {
  return `${byName} couldn't answer your question (${askId}): ${why}. Continue without it, ask someone else, or ask the user (@user).`;
}

// ── Turns ─────────────────────────────────────────────────────────────

/** A stuck turn was stopped: the next one says why. */
export function nudgeInstruction(stuck: string): string {
  return (
    `NUDGE: your last turn was stopped because it ${stuck}. ` +
    "Don't run commands that never exit on their own (dev servers, watchers, the app itself) in the foreground: " +
    'run them in the background with a time limit, or skip them and say what you could not check. ' +
    'Look at where you got to, then continue.'
  );
}

export function discussionRoundInstruction(round: number, max: number): string {
  return `Discussion round ${round} of ${max}: reply only if you have something NEW to add (a disagreement, a gap, or a concrete improvement to what teammates said). Otherwise reply exactly [[pass]].`;
}

export const DEBATE_PROPOSE =
  'DEBATE ROUND 1: propose your own approach to the topic independently. Cover architecture, key risks and how you would split the work. Do not edit files.';
export const DEBATE_CRITIQUE =
  "DEBATE ROUND 2: critique your teammates' proposals. Name the strongest ideas, the real flaws, and what the final plan should keep. Be concise. Do not edit files.";
export const DEBATE_SYNTHESIS =
  'DEBATE SYNTHESIS: as leader, merge the best ideas into one plan. Write it to PLAN.md and the task split to tasks.json, then summarize the decisions in chat.';

/** The turn header line about desktop tests, so agents never run them (they take over the real mouse). */
export function desktopTestsLine(command: string): string {
  return `[desktop tests: never run \`${command}\` yourself: it takes over the user's real mouse and screen. The app runs it on the desktop after you mark a task done (when the user, or the App helper on an idle computer, presses Run now) and sends you the output if it fails. Don't mark a task blocked because you can't run these.]`;
}

/** A short label for what a turn is for, from its instruction (for the status line). */
export function activityOf(instruction?: string): string {
  const i = instruction ?? '';
  let m: RegExpMatchArray | null;
  if ((m = i.match(/REVIEW REQUEST \(([^)]+)\): task (\S+) "[^"]*", built by (\S+)/))) return `${m[1]} of ${m[2]} for ${m[3]}`;
  if ((m = i.match(/CHANGES REQUESTED on (\S+)/))) return `fixing ${m[1]} after review`;
  if (/CHANGES REQUESTED \(line comments/.test(i)) return 'working through line comments';
  if ((m = i.match(/(?:AUTOPILOT: keep going|UNBLOCKED:)\. Next unfinished task: (\S+)/) ?? i.match(/UNBLOCKED:.*?task: (\S+)/))) return `building ${m[1]}`;
  if ((m = i.match(/QUESTION from (\S+)/))) return `answering ${m[1]}'s question`;
  if ((m = i.match(/ANSWER from (\S+)/))) return `continuing with ${m[1]}'s answer`;
  if (/BUILD phase has started/.test(i)) return 'starting its build tasks';
  if (/REVIEW phase has started/.test(i)) return "reviewing teammates' branches";
  if (/Discussion round (\d+)/.test(i)) return `discussion round ${i.match(/Discussion round (\d+)/)![1]}`;
  if (/NUDGE:/.test(i)) return 'continuing after a nudge';
  return 'replying';
}

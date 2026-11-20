const $ = (s) => document.querySelector(s);
const MAX_LOG_LINES = 500;
const ROLES = [
  ['none', 'No role', 'No assigned job: works on whatever the team asks.'],
  ['builder', 'Builder', 'Implements the tasks it owns, runs the tests, commits, and marks them done.'],
  ['first_reviewer', 'First reviewer', "Checks a teammate's finished task first: bugs, missing pieces, mismatches with the plan."],
  ['final_reviewer', 'Final reviewer', 'The last, strictest check before a task is accepted. Looks for what the others missed.'],
  ['tester', 'Tester', "Writes and runs tests for teammates' work and reports failures."],
  ['arbiter', 'Arbiter', "Resolves merge conflicts between teammates' branches impartially."],
  ['custom', 'Custom…', 'Describe this agent’s job in your own words.'],
];
const STAGE_LABELS = { first: 'first review', final: 'final review', cross: 'review', tests: 'tests', desktop: 'desktop tests' };
let selectedPreset = '';

const AUTONOMY = [
  ['read', 'Read-only', 'Can look at files but not change anything.'],
  ['edits', 'Edits + dev commands', 'Can change files in its own copy of the code and run common tools (git, npm, tests). Anything else is refused.'],
  ['auto', 'Auto (CLI safety check)', "The agent's own built-in safety check decides what's OK to run."],
  ['full', 'Full access', 'Can run any command without asking. Only use for tasks you trust.'],
];

let ws;
let state = { project: null, leader: 'user', phase: 'plan', gates: true, requests: [], agents: [] };
let messages = [];
/** Older chat messages exist than the ones on the page (the server sends the newest CHAT_PAGE_SIZE). */
let earlierMessages = false;
let loadingEarlier = false;
const CHAT_PAGE_SIZE = 200;
const MAX_CHAT_ON_PAGE = 1000;
let branches = [];
let team = { plan: '', tasks: '' };
let editingPlan = false;
let diffAgent = null; // agent whose diff is open in the Branches tab
let lastDiff = null; // the diff shown, so new comments redraw it without refetching
let commentsKey = '';
let restarting = false;
let helper = { messages: [], status: 'idle', editMode: false, changes: { files: [], ahead: 0 }, undoAvailable: false, supervised: false, gitOk: true };
const logs = {}; // agentId -> [{cls, text}]

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    setConn(true);
    // Back after an update: reload so the browser picks up the new UI code too.
    if (restarting) location.reload();
  };
  ws.onclose = () => {
    setConn(false);
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setConn(ok) {
  // Just a dot when healthy; spell it out only when something's wrong.
  $('#conn').textContent = ok ? '●' : 'reconnecting…';
  $('#conn').title = ok ? 'Connected' : 'Connection lost, retrying';
  $('#conn').classList.toggle('ok', ok);
}

function handle(m) {
  switch (m.type) {
    case 'state':
      if (m.state.project?.root !== state.project?.root) showDiff(null);
      state = m.state;
      renderAll();
      // Comments changed while a diff is open: redraw it in place.
      if (diffAgent && lastDiff && JSON.stringify(state.comments ?? []) !== commentsKey) renderDiff(lastDiff);
      break;
    case 'messages':
      messages = m.messages;
      earlierMessages = Boolean(m.earlier);
      loadingEarlier = false;
      renderMessages();
      break;
    case 'earlier_messages':
      // An answer for a list that has changed since (project switch, reconnect, trimmed while following):
      // don't prepend it, but let the button work again.
      if (m.before !== messages[0]?.id) {
        loadingEarlier = false;
        const b = document.querySelector('.earlier-bar button');
        if (b) Object.assign(b, { disabled: false, textContent: 'Load earlier messages' });
        break;
      }
      messages = [...m.messages, ...messages];
      earlierMessages = Boolean(m.earlier);
      loadingEarlier = false;
      renderMessages(true);
      break;
    case 'projects':
      renderProjects(m.projects);
      break;
    case 'message':
      messages.push(m.message);
      // A page left open for days: keep the chat light by dropping the oldest from the page
      // (they stay in the project's history and come back with "Load earlier messages").
      if (messages.length > MAX_CHAT_ON_PAGE && followChat) {
        messages = messages.slice(-CHAT_PAGE_SIZE);
        earlierMessages = true;
        renderMessages();
      } else appendMessage(m.message);
      break;
    case 'agent_event':
      onAgentEvent(m.agentId, m.event);
      break;
    case 'team':
      team = { plan: m.plan, tasks: m.tasks, overlaps: m.overlaps ?? [] };
      renderPlan();
      renderTasks();
      renderLiveStatus();
      break;
    case 'branches':
      branches = m.branches;
      renderBranches();
      renderLiveStatus();
      break;
    case 'diff':
      if (m.diff.agentId === diffAgent) renderDiff(m.diff);
      break;
    case 'agent_history':
      // Saved activity, so the panels aren't blank after a reload or project switch.
      for (const [id, lines] of Object.entries(m.history)) {
        logs[id] = lines.map((l) => (l.kind === 'text' ? textLine(l.text) : { cls: l.kind === 'tool' ? 'tool' : 'logline', text: l.text }));
      }
      $('#agentList').dataset.roster = '';
      renderAgents();
      break;
    case 'helper_state':
      helper = m.helper;
      renderHelper(true);
      break;
    case 'helper_message':
      helper.messages.push(m.message);
      appendHelperMessage(m.message);
      break;
    case 'helper_event':
      onHelperEvent(m.event);
      break;
    case 'helper_diff':
      $('#helperDiffBody').innerHTML = diffHtml(m.diff, 'Committed by the helper', 'Not committed yet (included when you apply)');
      break;
    case 'helper_error':
      if (m.busy && confirm(`${m.error}\n\nStop the agents and continue?`)) send({ type: m.retry, force: true });
      else if (!m.busy) appendHelperMessage({ from: 'system', text: `⚠ ${m.error}` });
      break;
    case 'restarting':
      restarting = true;
      $('#restarting').hidden = false;
      break;
    case 'agent_config':
      agentConfig = { agents: m.agents, adapters: m.adapters };
      // Suggestions for the Hermes profile field.
      $('#hermesProfiles').replaceChildren(...(m.hermesProfiles ?? []).map((p) => new Option(p)));
      if ($('#agentsDialog').open && !agentsDirty) renderAgentRows(m.agents);
      break;
    case 'agent_config_saved':
      agentsDirty = false;
      agentsSaving = false;
      $('#agentsDialog').close();
      break;
    case 'error':
      if (loadingEarlier) {
        loadingEarlier = false;
        const b = document.querySelector('.earlier-bar button');
        if (b) Object.assign(b, { disabled: false, textContent: 'Load earlier messages' });
      }
      if ($('#agentsDialog').open && agentsSaving) {
        agentsSaving = false;
        $('#agentsError').textContent = m.error;
        $('#agentsError').hidden = false;
        break;
      }
      if (diffAgent && $('#diffBody').textContent === 'Loading diff…') $('#diffBody').innerHTML = `<div class="empty">${esc(m.error)}</div>`;
      appendMessage({ from: 'system', to: 'user', text: `⚠ ${m.error}` });
      break;
  }
}

// ── Rendering ──────────────────────────────────────────────────────────

const agentById = (id) => state.agents.find((a) => a.id === id);
const nameOf = (id) => (id === 'user' ? 'You' : id === 'system' ? 'System' : agentById(id)?.name ?? id);

function renderAll() {
  const p = state.project;
  $('#projectInfo').textContent = p ? `${p.name} — ${p.root}` : 'No project open. Create or open one above.';
  if (p) $('#projectSelect').value = p.name;

  fillSelect($('#leaderSelect'), [['user', 'You'], ...state.agents.map((a) => [a.id, a.name])], state.leader);
  fillSelect($('#toSelect'), [['all', 'Everyone'], ...state.agents.map((a) => [a.id, `DM ${a.name}`])], $('#toSelect').value || 'all');
  document.querySelectorAll('#phases button').forEach((b) => b.classList.toggle('active', b.dataset.phase === state.phase));
  $('#gates').checked = state.gates;
  $('#autopilot').checked = state.autopilot;
  $('#debate').disabled = state.debating;
  $('#debate').textContent = state.debating ? 'Debating…' : 'Debate';

  renderLiveStatus();
  renderHelperAttention();
  renderRequests();
  renderUsageTotal();
  renderAgents();
  renderTasks();
  renderBranches();
}

function attentionCount() {
  return (state.requests?.length ?? 0) + (state.needsYou?.length ?? 0) +
    (state.stalls?.length ?? 0) + Number(Boolean(state.resume)) + Number(Boolean(state.limitHit)) +
    Object.values(state.reviews ?? {}).filter((r) => r.status === 'stuck').length;
}

/** Every task accepted, nothing running or waiting on you, and no branch with work still to merge. */
function projectFinished() {
  const working = state.agents.some((a) => a.status === 'working');
  const waiting = state.agents.some((a) => a.waitingFor || /queued|waiting|setting up|review.*requested/i.test(a.statusLine ?? '')) ||
    Object.values(state.reviews ?? {}).some((r) => r.status === 'in_review');
  // Uncommitted files (often test output) don't count; commits not yet in main do (e.g. a failed auto-merge).
  const unmerged = branches.some((b) => b.ahead > 0);
  return Boolean(state.project) && state.allTasksAccepted && !working && !attentionCount() && !waiting && !unmerged && !state.debating;
}

function renderLiveStatus() {
  const working = state.agents.filter((a) => a.status === 'working').length;
  const needs = attentionCount();
  const waiting = state.agents.some((a) => a.waitingFor || /queued|waiting|setting up|review.*requested/i.test(a.statusLine ?? '')) ||
    Object.values(state.reviews ?? {}).some((r) => r.status === 'in_review');
  const finished = projectFinished();
  const phase = { plan: 'Planning', build: 'Building', review: 'Reviewing' }[state.phase] ?? 'Working';
  $('#liveStatus').textContent = !state.project ? 'Open a project to begin' : finished
    ? 'Finished · nothing needs you'
    : `${working || waiting || state.debating ? phase : 'Ready'} · ${working} working${needs ? ` · ${needs} needs you` : ''}`;
  document.querySelectorAll('#phases button').forEach((b) => b.classList.toggle('active', b.dataset.phase === state.phase));
  // Big green banner when it's all done, with main's tip so you can tell it's the final state.
  const banner = $('#finishedBanner');
  banner.hidden = !finished;
  if (finished) {
    const sha = branches.find((b) => b.mainCommit)?.mainCommit;
    banner.textContent = `✓ FINISHED · everything merged into main${sha ? ` (${sha})` : ''}`;
  }
}

function renderHelperAttention() {
  const bar = $('#helperAttention');
  const count = attentionCount();
  bar.hidden = !count;
  bar.replaceChildren();
  if (!count) return;
  const text = document.createElement('span');
  text.textContent = `${count} item${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} your decision`;
  const button = document.createElement('button');
  button.textContent = 'Show decisions';
  button.onclick = () => {
    setMobileView('chat');
    const inChat = (state.requests?.length ?? 0) + (state.needsYou?.length ?? 0) + (state.stalls?.length ?? 0) + Number(Boolean(state.resume)) + Number(Boolean(state.limitHit));
    if (!inChat && Object.values(state.reviews ?? {}).some((r) => r.status === 'stuck')) {
      showTab('tasks');
      setMobileView('workspace');
    } else $('#requests').scrollIntoView({ block: 'nearest' });
  };
  bar.append(text, button);
}

/**
 * Full redraw only on project open/reconnect (or after loading earlier messages); live messages are
 * appended so your scroll position stays put. `keepPlace`: older messages were added on top, so keep
 * what you were looking at where it was.
 */
function renderMessages(keepPlace = false) {
  const box = $('#messages');
  const fromBottom = box.scrollHeight - box.scrollTop;
  const newHidden = $('#newMsgs').hidden;
  box.innerHTML = '';
  if (earlierMessages) box.appendChild(earlierBar());
  const follow = followChat;
  followChat = false; // no scrolling per message while redrawing
  messages.forEach(appendMessage);
  if (keepPlace) {
    followChat = follow;
    box.scrollTop = box.scrollHeight - fromBottom;
    $('#newMsgs').hidden = newHidden;
  } else {
    followChat = true;
    scrollChatToEnd();
  }
}

/** The "Load earlier messages" button above the oldest message shown. */
function earlierBar() {
  const bar = document.createElement('div');
  bar.className = 'earlier-bar';
  const b = document.createElement('button');
  b.textContent = loadingEarlier ? 'Loading…' : 'Load earlier messages';
  b.title = `Show the ${CHAT_PAGE_SIZE} messages before these. The whole chat is also saved in the project's team/chat.jsonl.`;
  b.disabled = loadingEarlier || !messages.length;
  b.onclick = () => {
    loadingEarlier = true;
    b.disabled = true;
    b.textContent = 'Loading…';
    send({ type: 'load_earlier', before: messages[0].id });
  };
  bar.appendChild(b);
  return bar;
}

// Follow new messages unless you've scrolled up to read; "New messages ↓" brings you back.
let followChat = true;
function scrollChatToEnd() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
  $('#newMsgs').hidden = true;
}
$('#messages').addEventListener('scroll', () => {
  const box = $('#messages');
  followChat = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (followChat) $('#newMsgs').hidden = true;
});
// Coming back from another browser tab: catch up if you were following.
document.addEventListener('visibilitychange', () => !document.hidden && followChat && scrollChatToEnd());
$('#newMsgs').onclick = () => {
  followChat = true;
  scrollChatToEnd();
};

function fillSelect(el, opts, value) {
  el.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  el.value = value;
}

function renderProjects(projects) {
  fillSelect($('#projectSelect'), [['', '— open project —'], ...projects.map((p) => [p, p])], state.project?.name ?? '');
}

function appendMessage(m) {
  const box = $('#messages');
  const routine = m.from === 'system' && (m.to === 'all' || m.to === 'user') &&
    !/\?|@user|fail|error|block|needs|waiting|stuck|couldn|conflict/i.test(m.text) &&
    (/^\u2713 .+ accepted(?:[ .(]|$)/.test(m.text) || /\u2192 running tests:|^Tests passed\.|^Merged agent\/|^\u2713 (?!All tasks)\S+'s accepted work is merged into main\./.test(m.text));
  const previous = box.lastElementChild;
  if (routine && previous?.classList.contains('routine-update')) {
    let group = previous;
    if (previous.tagName !== 'DETAILS') {
      group = document.createElement('details');
      group.className = 'routine-update updates';
      group.appendChild(document.createElement('summary'));
      previous.replaceWith(group);
      group.appendChild(previous);
    }
    const line = document.createElement('div');
    line.className = 'msg system';
    line.textContent = m.text;
    group.appendChild(line);
    group.querySelector('summary').textContent = `${group.children.length - 1} updates`;
    if (followChat) scrollChatToEnd();
    return;
  }
  const el = document.createElement('div');
  el.className = `msg ${m.from === 'user' ? 'user' : m.from === 'system' ? 'system' : ''}`;
  const color = agentById(m.from)?.color;
  if (color) el.style.setProperty('--c', color);
  if (m.from === 'system') {
    // to 'user' = notices only you see; to an agent = an instruction sent privately to it.
    el.textContent = m.to !== 'all' && m.to !== 'user' ? `→ ${nameOf(m.to)}: ${m.text}` : m.text;
    if (m.to === 'user' && /fail|error|timed out|couldn|⚠|crash|blocked/i.test(m.text)) {
      const b = document.createElement('button');
      b.className = 'ask-helper';
      b.textContent = 'Ask helper';
      b.title = 'Ask the helper what this means and how to fix it';
      b.onclick = () => askHelper(m.text);
      el.appendChild(b);
    }
  } else {
    const dm = m.to !== 'all' ? ` <span class="dm">→ ${esc(nameOf(m.to))} (private)</span>` : '';
    // A question for you inside a long reply is shown on top, so it isn't buried at the end.
    const asks = m.from !== 'user' ? m.text.split('\n').filter((l) => /@user\b/i.test(l)) : [];
    const ask = asks.length ? `<div class="ask-you"><b>Question for you:</b> ${asks.map((l) => mdInline(l.trim())).join('<br>')}</div>` : '';
    el.innerHTML = `<div class="who">${esc(nameOf(m.from))}${dm}</div>${ask}<div class="body md">${md(m.text)}</div>`;
    const long = m.text.length > 1500 || m.text.split('\n').length > 30;
    if (long) {
      const body = el.querySelector('.body');
      body.classList.add('collapsed');
      const more = document.createElement('button');
      more.className = 'more';
      more.textContent = 'Show more';
      more.title = 'Show the whole message.';
      more.onclick = () => {
        const open = body.classList.toggle('collapsed');
        more.textContent = open ? 'Show more' : 'Show less';
      };
      el.appendChild(more);
    }
    if (m.attachments?.length) el.appendChild(attachmentsEl('project', m.attachments));
  }
  if (routine) el.classList.add('routine-update');
  box.appendChild(el);
  if (m.from === 'user') followChat = true; // you just sent it: follow the conversation again
  if (followChat) scrollChatToEnd();
  else if (m.from !== 'system') $('#newMsgs').hidden = false;
}

// ── Markdown (small and safe: everything is escaped first) ─────────────

/** Inline: `code`, **bold**, *italic*, [link](https://…), and [[markers]] as small tags. */
function mdInline(src) {
  const codes = [];
  let s = esc(src).replace(/`([^`]+)`/g, (_, c) => `\u0001${codes.push(`<code>${c}</code>`) - 1}\u0001`);
  s = s
    .replace(/\[\[([^\]]{1,200})\]\]/g, '<span class="marker">$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[Number(i)]);
}

/** Blocks: ``` fences, # headings, - / 1. lists, > quotes, paragraphs. */
function md(src) {
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => para.length && (out.push(`<p>${para.join('<br>')}</p>`), (para = []));
  const flushList = () => list && (out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`), (list = null));
  const lines = String(src).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```/);
    if (fence) {
      flushPara();
      flushList();
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre class="code"><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara();
      flushList();
      out.push(`<div class="h h${m[1].length}">${mdInline(m[2])}</div>`);
    } else if ((m = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/))) {
      flushPara();
      const tag = m[1] ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(mdInline(m[3]));
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara();
      flushList();
      out.push(`<blockquote>${mdInline(m[1])}</blockquote>`);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(mdInline(line));
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

/** Thumbnails for images and 📄 chips for text files; click opens them in a new tab. */
function attachmentsEl(scope, names) {
  const wrap = document.createElement('div');
  wrap.className = 'images';
  for (const n of names) {
    const a = document.createElement('a');
    a.href = `/attachments/${scope}/${encodeURIComponent(n)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    const label = attachmentLabel(n);
    if (IMAGE_EXTS.includes(extOf(n))) {
      a.title = `Open ${label} full size`;
      const img = document.createElement('img');
      img.src = a.href;
      img.alt = label;
      img.loading = 'lazy';
      a.appendChild(img);
    } else {
      a.className = 'file-chip';
      a.title = `Open ${label}`;
      a.textContent = `📄 ${label}`;
    }
    wrap.appendChild(a);
  }
  return wrap;
}

/** Saved setups for the limit banner: ones that don't rely on the limited agent first. */
function presetOptions(agentId) {
  const uses = (p) => (p.roles?.[agentId]?.role ?? 'none') !== 'none' || p.leader === agentId;
  const list = [...(state.presets ?? [])].sort((a, b) => Number(uses(a)) - Number(uses(b)));
  return list.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${uses(p) ? ` (still uses ${esc(nameOf(agentId))})` : ''}</option>`).join('');
}

function limOut(id) {
  const a = state.agents.find((x) => x.id === id);
  return a?.outUntil ? ` and is out until ${fmtClock(a.outUntil)}` : '';
}

function renderRequests() {
  const label = (r) =>
    r.kind === 'phase' ? `move to ${r.value.toUpperCase()} phase` : `merge agent/${r.value} into main`;
  const lim = state.limitHit;
  const limit = lim
    ? `<div class="request" title="${esc(lim.text)}"><span><b>${esc(lim.name)}</b> hit a usage limit${limOut(lim.agent)}. It's skipped until then. Switch to a saved setup?</span>
        <select data-limit-preset title="Pick the setup to switch to. Setups that still give ${esc(lim.name)} a role are listed last.">${presetOptions(lim.agent)}</select>
        <button data-limit-apply title="Apply the chosen setup now.">Switch</button>
        <button data-limit-dismiss class="danger" title="Hide this. Nothing changes.">Dismiss</button></div>`
    : '';
  const needs = (state.needsYou ?? [])
    .map(
      (n) => `<div class="request needs-you"><span title="${esc(n.text)}"><b>${esc(n.name)}</b> needs you: ${esc(n.text.replace(/\s+/g, ' ').slice(0, 160))}</span>
        ${(n.options ?? []).map((o) => `<button data-needs-option="${esc(n.agent)}" data-option="${esc(o)}" title="Answer ${esc(n.name)} privately with this choice.">${esc(o)}</button>`).join('')}
        <button data-needs-reply="${esc(n.agent)}" title="Answer ${esc(n.name)} in the chat box (starts your message with @${esc(n.agent)}).">Reply</button>
        <button data-needs-dismiss="${esc(n.agent)}" class="danger" title="Hide this without replying.">Dismiss</button></div>`,
    )
    .join('');
  const stalls = (state.stalls ?? [])
    .map(
      (st) => `<div class="request stall"><span title="Flagged ${esc(new Date(st.since).toLocaleTimeString())}. No output for a while, or the same command over and over."><b>${esc(st.name)}</b> may be stuck: ${esc(st.reason)}</span>
        <button data-stall="wait" data-agent="${esc(st.agent)}" title="It's probably fine (e.g. a long build). Ask again later if it's still quiet.">Keep waiting</button>
        <button data-stall="nudge" data-agent="${esc(st.agent)}" title="Stop this turn and start a new one telling ${esc(st.name)} why, so it can continue another way. Anything it already said is kept.">Nudge</button>
        <button data-stall="stop" data-agent="${esc(st.agent)}" class="danger" title="Stop ${esc(st.name)} now.">Stop</button></div>`,
    )
    .join('');
  const rs = state.resume;
  const resume = rs
    ? `<div class="request"><span title="The app was closed or restarted${rs.at ? ` (last saved ${esc(fmtClock(rs.at))})` : ''}. Continue gives each cut-off agent a turn to check its work and finish, in its own CLI session so it remembers, restarts autopilot, and asks again for reviews that were in progress.">${
        rs.names.length ? `The app closed while <b>${esc(rs.names.join(', '))}</b> ${rs.names.length > 1 ? 'were' : 'was'} working` : 'The app closed while autopilot was running'
      }${rs.names.length && rs.looping.length ? ' (autopilot on)' : ''}. Pick up where they left off?</span>
        <button data-resume="continue" title="Each cut-off agent checks its work and finishes it; autopilot and reviews start again.">Continue</button>
        <button data-resume="dismiss" class="danger" title="Leave everything stopped. You can still message agents or turn autopilot on yourself.">Dismiss</button></div>`
    : '';
  const dt = state.desktopTests ?? { waiting: [] };
  const run = dt.run;
  const secs = run && !run.running ? Math.max(0, Math.ceil((run.startsAt - Date.now()) / 1000)) : 0;
  const desktop =
    (run
      ? `<div class="request desktop-run"><span title="${esc(dt.command)}">${
          run.running
            ? `<b>Desktop tests running</b> for ${esc(run.task)}: they move the mouse, so hands off until they finish.`
            : secs > 0
              ? `<b>${run.by === 'helper' ? 'The App helper starts' : 'Starting'} the desktop tests</b> for ${esc(run.task)} in <b>${secs}s</b>. They'll move the mouse.`
              : `<b>Getting ready</b> to run the desktop tests for ${esc(run.task)} (setting up the code copy). They'll move the mouse once they start.`
        }</span>${
          run.running
            ? `<button data-desktop="cancel" class="danger" title="End the running tests now. The task keeps waiting for Run now.">Stop</button>`
            : `<button data-desktop="cancel" class="danger" title="Don't run them now; they keep waiting for Run now.">Cancel</button>`
        }</div>`
      : '') +
    dt.waiting
      .filter((id) => id !== run?.task)
      .map(
        (id) => `<div class="request desktop"><span title="${esc(dt.command)}"><b>${esc(id)}</b> waits for the desktop tests. They use your mouse and screen for a while.</span>
        <button data-desktop="run" data-task="${esc(id)}" ${run ? 'disabled' : ''} title="Run them now: don't touch the mouse or keyboard until they finish.">Run now</button>
        <button data-desktop="skip" data-task="${esc(id)}" class="danger" title="Accept this task without its desktop tests.">Skip</button></div>`,
      )
      .join('');
  clearTimeout(renderRequests.tick);
  if (run && !run.running) renderRequests.tick = setTimeout(renderRequests, 1000);
  // A count in the browser tab title, so you notice from another tab.
  const count = (state.needsYou?.length ?? 0) + (state.stalls?.length ?? 0) + dt.waiting.length;
  document.title = count ? `(${count}) Thinktank Studio` : 'Thinktank Studio';
  $('#requests').innerHTML = desktop + resume + stalls + needs + limit + state.requests
    .map(
      (r) => `<div class="request"><span><b>${esc(nameOf(r.from))}</b> asks to ${esc(label(r))}${r.kind === 'merge' && unaccepted(r.value).length ? ` <span class="pill doing" title="Tasks of this agent that aren't accepted yet.">not accepted: ${esc(unaccepted(r.value).join(', '))}</span>` : ''}</span>
        <button data-approve="${esc(r.id)}" title="Allow it. The phase change or merge happens now.">Approve</button>
        <button data-reject="${esc(r.id)}" class="danger" title="Say no. The leader sees that you rejected it.">Reject</button></div>`,
    )
    .join('');
}

/** Rebuild agent panels only when the roster changes, so typing in a picker isn't interrupted. */
function renderAgents() {
  renderTeamBar();
  const wrap = $('#agentList');
  const roster = state.agents.map((a) => a.id).join(',');
  if (wrap.dataset.roster !== roster) {
    wrap.dataset.roster = roster;
    wrap.innerHTML = '';
    for (const a of state.agents) wrap.appendChild(buildAgent(a));
    // Once laid out (on a fresh page load the boxes get their height a moment later).
    requestAnimationFrame(stickLogs);
    setTimeout(stickLogs, 300);
  }
  for (const a of state.agents) updateAgent(a);
}

function buildAgent(a) {
  const el = document.createElement('div');
  el.className = 'agent';
  el.id = `agent-${a.id}`;
  el.style.setProperty('--c', a.color);
  el.innerHTML = `
    <div class="agent-head">
      <span class="dot" title="Grey = idle, orange = working, red = its last turn failed (see the activity below)."></span>
      <span class="name">${esc(a.name)}</span>
      <span class="lead"></span>
      <span class="usage"></span>
      <span class="away"></span>
      <button class="try-now" data-try-now="${esc(a.id)}" hidden title="Mark it available now (e.g. its limit reset early or you upgraded). If it's still limited, its next turn will say so.">Try now</button>
      <label class="on-switch" title="Switch this agent off to leave it out completely: no turns, reviews or hand-offs. Its pending reviews go to others. Switch it back on any time."><input type="checkbox" class="agent-on" /> On</label>
      <button class="settings-toggle" aria-expanded="false">Settings</button>
      <button data-stop="${esc(a.id)}" title="Stop this agent's current turn and cancel anything waiting for it.">Stop</button>
    </div>
    <div class="status-line" title="What this agent is doing right now, or why it's waiting."></div>
    <div class="plan-limits" hidden></div>
    ${a.catalog ? `
    <div class="agent-settings" hidden>
      <select class="profile" hidden title="Which Hermes profile this agent runs as. Each profile has its own default model, memory and skills, for example a coding profile with a coding model. (default) marks the one set in agents.config.json."></select>
      <select class="model" title="Which AI model this agent uses. The list comes from the CLI itself, so new models appear after you update the CLI. (default) marks the one set in agents.config.json."></select>
      <select class="effort" title="How hard the model thinks before answering. Higher is better for hard problems but slower and uses more of your plan's limits. Only the levels the chosen model accepts are listed."></select>
      <select class="autonomy" title="What this agent may do without asking you first. Hover each choice for details.">${AUTONOMY.map(([v, t, tip]) => `<option value="${v}" title="${esc(tip)}">${t}</option>`).join('')}</select>
    </div>` : ''}
    <div class="agent-role" hidden>
      <select class="role" title="This agent's job on the team. It's told its role with every turn, so a change applies from its next turn.">${ROLES.map(([v, t, tip]) => `<option value="${v}" title="${esc(tip)}">${t}</option>`).join('')}</select>
      <input class="role-custom" placeholder="Describe this agent's job" title="The custom role, in your own words. Press Enter or click away to save." hidden />
    </div>
    <button class="log-toggle" aria-expanded="false"></button>
    <div class="log" hidden></div>
    <div class="log-resize" title="Drag to make this agent's activity box taller or shorter (dragging a closed box opens it). Double-click to go back to the normal size."></div>`;
  makeLogResizable(el, a.id);

  el.querySelector('.settings-toggle').onclick = () => {
    el.dataset.settings = el.dataset.settings === 'open' ? '' : 'open';
    updateAgent(agentById(a.id));
  };
  el.querySelector('.log-toggle').onclick = () => {
    el.dataset.logOpen = el.dataset.logOpen === 'true' ? 'false' : 'true';
    updateAgentLog(a.id);
  };
  const set = (patch) => send({ type: 'set_settings', agentId: a.id, settings: patch });
  el.querySelector('.agent-on').onchange = (e) => send({ type: 'set_agent_enabled', agentId: a.id, on: e.target.checked });
  el.querySelector('.try-now').onclick = () => send({ type: 'clear_out_of_usage', agentId: a.id });
  const model = el.querySelector('.model');
  if (model) {
    model.onchange = async () => {
      if (model.value !== OTHER_MODEL) return set({ model: model.value });
      const id = (await askText('Model id, exactly as the CLI names it:', agentById(a.id).settings.model))?.trim();
      if (id) set({ model: id });
      else fillModelPicker(model, agentById(a.id));
    };
    el.querySelector('.effort').onchange = (e) => set({ effort: e.target.value });
    el.querySelector('.profile').onchange = (e) => set({ profile: e.target.value });
    el.querySelector('.autonomy').onchange = (e) => {
      if (e.target.value === 'full' && !confirm(`Give ${a.name} full access? It can run any command without asking.`)) {
        e.target.value = agentById(a.id).settings.autonomy;
        return;
      }
      set({ autonomy: e.target.value });
    };
  }
  const role = el.querySelector('.role');
  const custom = el.querySelector('.role-custom');
  const sendRole = () => send({ type: 'set_role', agentId: a.id, assignment: { role: role.value, custom: custom.value } });
  role.onchange = () => {
    custom.hidden = role.value !== 'custom';
    if (role.value === 'custom') custom.focus();
    else sendRole();
  };
  custom.onchange = sendRole;
  (logs[a.id] ?? []).forEach((l) => addLogLine(a.id, l, false, el));
  // Each box follows new output while you're at its bottom, and stays put once you scroll up.
  const log = el.querySelector('.log');
  log.addEventListener('scroll', () => {
    if (log.clientHeight) log.dataset.stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40 ? '1' : '0';
  });
  return el;
}

/** Roles switch and saved setups, above the agent list. */
function renderTeamBar() {
  const presets = state.presets ?? [];
  if (selectedPreset && !presets.some((p) => p.name === selectedPreset)) selectedPreset = '';
  const presetTip = (p) =>
    Object.entries(p.roles)
      .map(([id, r]) => `${nameOf(id)}: ${ROLES.find(([v]) => v === r.role)?.[1] ?? r.role}${p.models?.[id] ? ` (${p.models[id]})` : ''}`)
      .concat(p.leader ? [`Leader: ${nameOf(p.leader)}`] : [], p.review ? [`Review: ${p.review}`] : [])
      .join('\n');
  $('#teamBar').innerHTML = `
    <label class="check" title="Give each agent a job (builder, reviewer…). Off by default: agents work without assigned roles."><input type="checkbox" id="rolesOn" ${state.roles?.enabled ? 'checked' : ''} /> Roles</label>
    <select id="presetSelect" title="Saved team setups: roles, leader, review mode and models in one click. Useful when an agent runs out of usage.">
      <option value="">Saved setups…</option>
      ${presets.map((p) => `<option value="${esc(p.name)}" title="${esc(presetTip(p))}" ${p.name === selectedPreset ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
    </select>
    <button id="presetApply" class="small" title="Apply the chosen setup now. Takes effect from each agent's next turn." ${selectedPreset ? '' : 'disabled'}>Apply</button>
    <button id="presetSave" class="small" title="Save the current roles, leader, review mode and models as a named setup.">Save current…</button>
    <button id="presetDelete" class="small danger" title="Delete the chosen saved setup." ${selectedPreset ? '' : 'disabled'}>Delete</button>`;
  $('#rolesOn').onchange = (e) => send({ type: 'set_roles_enabled', on: e.target.checked });
  $('#presetSelect').onchange = (e) => {
    selectedPreset = e.target.value;
    renderTeamBar();
  };
  $('#presetApply').onclick = () => selectedPreset && send({ type: 'apply_preset', name: selectedPreset });
  $('#presetDelete').onclick = () => selectedPreset && confirm(`Delete the setup "${selectedPreset}"?`) && send({ type: 'delete_preset', name: selectedPreset });
  $('#presetSave').onclick = async () => {
    const name = await askText('Name for this setup (e.g. "Claude out of limits"):', selectedPreset || '');
    if (name?.trim()) send({ type: 'save_preset', name: name.trim() });
  };
}

const OTHER_MODEL = '__other__';

/** Rebuild a <select> only when its options change, so an open dropdown isn't reset by every state push. */
function setOptions(sel, opts, value) {
  const key = JSON.stringify(opts);
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    sel.replaceChildren(...opts.map(([v, t]) => new Option(t, v)));
  }
  sel.value = value;
}

/** Hermes profiles; hidden for other CLIs. Empty = the profile Hermes itself has active. */
function fillProfilePicker(sel, a) {
  const profiles = a.catalog.profiles;
  sel.hidden = !profiles?.length;
  if (sel.hidden) return;
  const def = a.defaults.profile;
  const current = a.settings.profile || '';
  const active = `${a.catalog.activeProfile || 'default'}${a.catalog.activeMissing ? ', not found' : ''}`;
  // Always offered, even when agents.config.json names a profile, so you can go back to Hermes's own pick.
  const opts = [['', `Profile: Hermes's active (${active})${def ? '' : ' (default)'}`]];
  for (const p of profiles) opts.push([p, `Profile: ${p}${p === def ? ' (default)' : ''}`]);
  // A profile that was removed from Hermes since: keep it visible so the pick isn't silently changed.
  if (current && !profiles.includes(current)) opts.push([current, `Profile: ${current} (not found)`]);
  setOptions(sel, opts, current);
}

/** Models from the CLI's own list; the configured default is marked, and a hand-typed id is kept. */
function fillModelPicker(sel, a) {
  const cat = a.catalog;
  const def = a.defaults.model;
  const opts = [];
  // A Hermes profile has its own default model.
  const from = cat.profiles ? 'profile default' : 'CLI default';
  if (!def) opts.push(['', `Model: ${from}${cat.cliDefaultModel ? ` (${cat.cliDefaultModel})` : ''}`]);
  // Listed models, plus the configured default and the current pick even when the CLI hides them.
  const shown = cat.models.filter((m) => !m.hidden || m.id === def || m.id === a.settings.model);
  for (const m of shown) opts.push([m.id, `${m.label || m.id}${m.id === def ? ' (default)' : ''}`]);
  for (const id of new Set([def, a.settings.model])) {
    if (id && !shown.some((m) => m.id === id)) opts.push([id, `${id}${id === def ? ' (default)' : ''}`]);
  }
  opts.push([OTHER_MODEL, 'Other model id…']);
  setOptions(sel, opts, a.settings.model);
}

/** Only the efforts the selected model accepts (any other makes the turn fail). */
function fillEffortPicker(sel, a) {
  const cat = a.catalog;
  const m = cat.models.find((x) => x.id === (a.settings.model || cat.cliDefaultModel));
  const def = a.defaults.effort;
  const opts = [];
  if (!def) {
    const cli = cat.cliDefaultEffort || m?.defaultEffort;
    opts.push(['', `Effort: CLI default${cli ? ` (${cli})` : ''}`]);
  }
  for (const e of m?.efforts ?? cat.efforts) opts.push([e, `Effort: ${e}${e === def ? ' (default)' : ''}`]);
  if (a.settings.effort && !opts.some(([v]) => v === a.settings.effort)) opts.push([a.settings.effort, `Effort: ${a.settings.effort}`]);
  setOptions(sel, opts, a.settings.effort);
  // A model server's models have no effort levels (reasoning is set in the server's app).
  sel.hidden = opts.length < 2;
}

/** "3:16 AM", or "Oct 25, 3:16 AM" when it isn't today. */
function fmtClock(ms) {
  if (ms >= 8.64e15) return 'you click Try now'; // the limit message gave no reset time
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** "Plan: 5h 24% · week 61%" from the CLI's last report; hidden when the CLI doesn't report it (Grok). */
function renderPlanLimits(el, a) {
  const l = a.limits;
  el.hidden = !l?.windows?.length;
  if (el.hidden) return;
  const worst = Math.max(...l.windows.map((w) => w.usedPct));
  el.className = `plan-limits ${worst >= 95 ? 'bad' : worst >= 80 ? 'warn' : ''}`;
  el.textContent = `Usage limits: ${l.windows.map((w) => `${w.name} ${w.usedPct}%${w.resetsAt ? ` (resets ${fmtClock(w.resetsAt)})` : ''}`).join(' · ')}`;
  el.title =
    l.windows.map((w) => `${w.name}: ${w.usedPct}% used${w.resetsAt ? `, resets ${fmtClock(w.resetsAt)}` : ''}`).join('\n') +
    `\nAs ${a.name}'s CLI last reported it (${fmtClock(l.at)}). It updates after each of its turns.`;
}

function updateAgent(a) {
  const el = document.getElementById(`agent-${a.id}`);
  if (!el) return;
  el.querySelector('.dot').className = `dot ${a.status}`;
  const roleRow = el.querySelector('.agent-role');
  const settingsOpen = el.dataset.settings === 'open';
  roleRow.hidden = !settingsOpen || !state.roles?.enabled;
  const settings = el.querySelector('.agent-settings');
  if (settings) settings.hidden = !settingsOpen;
  el.querySelector('.settings-toggle').setAttribute('aria-expanded', String(settingsOpen));
  el.querySelector('[data-stop]').hidden = a.status !== 'working' && projectFinished();
  updateAgentLog(a.id);
  const assigned = state.roles?.assignments?.[a.id] ?? { role: 'none' };
  const roleSel = el.querySelector('.role');
  const custom = el.querySelector('.role-custom');
  if (document.activeElement !== roleSel) roleSel.value = assigned.role;
  custom.hidden = roleSel.value !== 'custom';
  if (document.activeElement !== custom) custom.value = assigned.custom ?? '';
  const auto = a.loop.active ? `auto ${a.loop.turns}/${state.autopilotMaxTurns}` : '';
  const roleName = state.roles?.enabled && assigned.role !== 'none' ? (assigned.role === 'custom' ? 'custom role' : ROLES.find(([v]) => v === assigned.role)?.[1]) : '';
  const waiting = a.waitingFor ? `waiting for ${nameOf(a.waitingFor)}'s answer` : '';
  el.querySelector('.lead').textContent = [state.leader === a.id ? '★ leader' : '', roleName, auto, waiting].filter(Boolean).join(' · ');
  el.querySelector('.lead').title = [
    state.leader === a.id ? 'This agent is the team leader.' : '',
    auto ? 'Autopilot is on: turns used in this run, out of the limit.' : '',
  ].filter(Boolean).join(' ');
  const sl = el.querySelector('.status-line');
  sl.textContent = a.statusLine ?? '';
  sl.className = `status-line ${/^working/.test(a.statusLine ?? '') ? 'working' : /^blocked|failed/.test(a.statusLine ?? '') ? 'bad' : ''}`;
  renderPlanLimits(el.querySelector('.plan-limits'), a);
  el.classList.toggle('off', a.disabled);
  const out = a.outUntil && a.outUntil > Date.now();
  const away = el.querySelector('.away');
  away.textContent = a.disabled ? 'off' : out ? `out until ${fmtClock(a.outUntil)}` : '';
  away.title = out ? 'Out of usage: skipped for turns, reviews and hand-offs until then, then it rejoins on its own. You can still message it directly.' : '';
  el.querySelector('.try-now').hidden = !out || a.disabled;
  const on = el.querySelector('.agent-on');
  if (document.activeElement !== on) on.checked = !a.disabled;
  const u = el.querySelector('.usage');
  u.textContent = a.totals.turns ? usageText(a.totals) : '';
  u.title = usageTitle(a.totals);
  const model = el.querySelector('.model');
  if (!model) return;
  const profile = el.querySelector('.profile');
  if (document.activeElement !== profile) fillProfilePicker(profile, a);
  if (document.activeElement !== model) fillModelPicker(model, a);
  const effort = el.querySelector('.effort');
  if (document.activeElement !== effort) fillEffortPicker(effort, a);
  el.querySelector('.autonomy').value = a.settings.autonomy;
}

function onAgentEvent(id, ev) {
  if (ev.kind === 'status') {
    const a = agentById(id);
    if (a) a.status = ev.status;
    const dot = document.querySelector(`#agent-${id} .dot`);
    if (dot) dot.className = `dot ${ev.status}`;
    if (a) updateAgent(a);
    renderLiveStatus();
    if (ev.status === 'working') pushLog(id, { cls: 'logline', text: '── turn started ──' });
    return;
  }
  const line =
    ev.kind === 'tool' ? { cls: 'tool', text: `▸ ${ev.name} ${ev.detail}` } :
    ev.kind === 'log' || ev.kind === 'tool_end' ? { cls: 'logline', text: ev.text } :
    textLine(ev.text);
  pushLog(id, line);
}

/** The full reply is in the chat; the activity panel keeps one line of it so tool calls stay in view. */
function textLine(text) {
  const t = String(text).trim();
  const first = t.split('\n').find((l) => l.trim()) ?? '';
  const short = first.length > 160 ? first.slice(0, 157) + '…' : first;
  return { cls: 'said', text: `💬 ${short}${t.length > short.length + 2 ? ' …' : ''}`, full: t };
}

function pushLog(id, line) {
  const arr = (logs[id] ??= []);
  arr.push(line);
  if (arr.length > MAX_LOG_LINES) arr.shift();
  addLogLine(id, line, true);
  updateAgentLog(id);
}

function updateAgentLog(id) {
  const el = document.getElementById(`agent-${id}`);
  if (!el) return;
  const working = agentById(id)?.status === 'working';
  if (el.dataset.wasWorking !== String(working)) {
    el.dataset.wasWorking = String(working);
    delete el.dataset.logOpen;
  }
  const open = working || el.dataset.logOpen === 'true';
  const said = [...(logs[id] ?? [])].reverse().find((l) => l.cls === 'said');
  const plain = (said?.full ?? '').replace(/\[\[[^\]]*\]\]/g, '').replace(/[*#`>]/g, '').trim();
  const sentences = plain.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g);
  const last = (sentences?.at(-1) ?? plain).trim().replace(/\s+/g, ' ');
  const toggle = el.querySelector('.log-toggle');
  toggle.textContent = open ? 'Hide activity' : (last || 'No activity yet') + ' · Show activity';
  toggle.title = last;
  toggle.hidden = working;
  toggle.setAttribute('aria-expanded', String(open));
  el.querySelector('.log').hidden = !open;
}

/**
 * The bar under an agent's activity box: drag it to set the box's height. The height is remembered
 * per agent in this browser; double-click goes back to the normal size.
 */
function makeLogResizable(el, id) {
  const log = el.querySelector('.log');
  const bar = el.querySelector('.log-resize');
  const key = `tts-log-height-${id}`;
  const apply = (px) => {
    log.style.height = px ? `${Math.round(Math.min(Math.max(px, 60), window.innerHeight * 0.85))}px` : '';
  };
  try { apply(Number(localStorage.getItem(key)) || 0); } catch {}
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // A closed box opens first, so the drag has something to size.
    if (log.hidden) {
      el.dataset.logOpen = 'true';
      updateAgentLog(id);
    }
    const startY = e.clientY;
    const startH = log.getBoundingClientRect().height;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');
    const move = (ev) => apply(startH + ev.clientY - startY);
    const end = () => {
      bar.classList.remove('dragging');
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', end);
      bar.removeEventListener('pointercancel', end);
      try { localStorage.setItem(key, String(Math.round(log.getBoundingClientRect().height))); } catch {}
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  });
  bar.addEventListener('dblclick', () => {
    apply(0);
    try { localStorage.removeItem(key); } catch {}
  });
}

function addLogLine(id, line, trim, root = document) {
  const log = root.querySelector(`#agent-${id} .log`) ?? (root.id === `agent-${id}` ? root.querySelector('.log') : null);
  if (!log) return;
  // A hidden or not-yet-shown box has no height to measure: it follows unless you scrolled it up.
  const atBottom = log.dataset.stick !== '0' && (!log.clientHeight || log.scrollHeight - log.scrollTop - log.clientHeight < 40);
  const d = document.createElement('div');
  d.className = line.cls;
  d.textContent = line.text;
  if (line.full) d.title = line.full.slice(0, 2000);
  log.appendChild(d);
  if (trim && log.childElementCount > MAX_LOG_LINES) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderPlan() {
  if (editingPlan) return; // don't clobber the user's edits; they'll see the latest on cancel
  const v = $('#planView');
  if (team.plan) v.innerHTML = md(team.plan);
  else v.textContent = state.project ? 'PLAN.md is empty.' : 'No project open.';
}

/** Task rows the user opened, kept across live updates. */
const openTasks = new Set();

function renderTasks() {
  const mode = $('#reviewMode');
  if (document.activeElement !== mode) mode.value = state.reviewMode ?? 'off';
  if (document.activeElement !== $('#testCmd')) $('#testCmd').value = state.testCommand ?? '';
  if (document.activeElement !== $('#desktopCmd')) $('#desktopCmd').value = state.desktopTests?.command ?? '';
  const box = $('#taskList');
  if (!team.tasks) {
    box.innerHTML = `<div class="empty">${state.project ? 'tasks.json is empty.' : 'No project open.'}</div>`;
    return;
  }
  let tasks;
  try {
    tasks = JSON.parse(team.tasks).tasks ?? [];
  } catch {
    box.innerHTML = `<div class="empty">tasks.json isn't valid JSON yet (an agent may be mid-edit).</div>`;
    return;
  }
  if (!tasks.length) {
    box.innerHTML = '<div class="empty">No tasks yet. The leader fills tasks.json during planning.</div>';
    return;
  }
  const overlaps = (team.overlaps ?? [])
    .map((o) => `<li>${esc(o.a.task)} (${esc(nameOf(o.a.owner))}: <code>${esc(o.a.pattern)}</code>) ↔ ${esc(o.b.task)} (${esc(nameOf(o.b.owner))}: <code>${esc(o.b.pattern)}</code>)</li>`)
    .join('');
  const warn = overlaps
    ? `<div class="overlap-warn"><b>These file areas may overlap</b>, so two agents could edit the same files and conflict at merge. Give each shared file one owner.<ul>${overlaps}</ul></div>`
    : '';
  const files = (t) => (Array.isArray(t.files) ? t.files.map((f) => `<code>${esc(f)}</code>`).join(' ') : '<span class="muted">any</span>');
  // Five columns fit half the window; files, dependencies and the hand-off open under the row.
  box.innerHTML = `${warn}<table class="task-table"><thead><tr><th>ID</th><th>Task <span class="muted">(click for details)</span></th><th title="The agent responsible for this task.">Owner</th><th>Status</th><th title="Where the task is in the review chain (when Review is on).">Review</th></tr></thead><tbody>${tasks
    .map((t) => {
      const id = String(t.id ?? '');
      const open = openTasks.has(id);
      const deps = Array.isArray(t.after) && t.after.length ? `<div><b>After:</b> ${afterCell(t, tasks)}</div>` : '';
      return `<tr class="task-row${open ? ' open' : ''}" data-task-row="${esc(id)}"><td>${esc(id)}</td><td class="task-title"><span class="caret">${open ? '▾' : '▸'}</span> <span class="tt">${esc(t.title ?? '')}</span>${t.note ? `<div class="task-note">${esc(t.note)}</div>` : ''}</td><td>${esc(nameOf(t.owner ?? ''))}${builderSelect(t)}</td>
        <td><span class="pill ${esc(t.status ?? '')}" title="${esc(STATUS_TIPS[t.status ?? 'todo'] ?? '')}">${esc(t.status ?? 'todo')}</span></td>
        <td>${reviewCell(t)}</td></tr>
        <tr class="task-more" ${open ? '' : 'hidden'}><td></td><td colspan="4"><div><b>Files:</b> <span class="files">${files(t)}</span></div>${deps}${t.handoff ? `<div class="handoff"><b>Hand-off:</b> ${esc(handoffTip(t))}</div>` : ''}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

// ── Usage ──────────────────────────────────────────────────────────────

const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
/**
 * Agents run on subscription logins, so tokens are the real measure; the dollar figure the CLIs
 * report is only what the same usage would cost at API prices, so it lives in the tooltip.
 */
const usageText = (t) => `${fmtTokens(t.input + t.output)} tok · ${t.turns} turn${t.turns === 1 ? '' : 's'}`;
const usageTitle = (t) => {
  const priced = t.turns - t.unpricedTurns;
  const api = priced ? `≈ $${t.costUsd.toFixed(t.costUsd < 1 ? 3 : 2)}${t.unpricedTurns ? '+' : ''} at API prices (not your subscription bill)` : 'No API-price estimate reported';
  return (
    `${t.input.toLocaleString()} in / ${t.output.toLocaleString()} out / ${t.cached.toLocaleString()} cached\n${api}` +
    (t.unpricedTurns ? `\n${t.unpricedTurns} turn(s) had no price (Codex reports tokens only)` : '')
  );
};

function renderUsageTotal() {
  const sum = { turns: 0, input: 0, output: 0, cached: 0, costUsd: 0, unpricedTurns: 0 };
  for (const a of state.agents) for (const k in sum) sum[k] += a.totals[k];
  $('#usageTotal').textContent = sum.turns ? `Σ ${usageText(sum)}` : '';
  $('#usageTotal').title = usageTitle(sum);
  $('#resetUsage').hidden = !sum.turns;
}

// ── Branches & diffs ───────────────────────────────────────────────────

function renderBranches() {
  const box = $('#branchList');
  if (!state.project) {
    box.innerHTML = '<div class="empty">No project open.</div>';
    return;
  }
  if (!branches.length) {
    box.innerHTML = '<div class="empty">Loading…</div>';
    return;
  }
  box.innerHTML = `<table><thead><tr><th title="Each agent works in its own copy of the code, called a branch.">Branch</th><th title="Commits this agent has that main doesn't (ready to merge), and commits in main it doesn't have yet (Sync brings them in).">Compared with main</th><th title="The agent's most recently saved change (a commit).">Last commit</th><th></th></tr></thead><tbody>${branches
    .map(
      (b) => `<tr>
        <td><b>${esc(nameOf(b.agentId))}</b><br><span class="muted">${esc(b.branch)}</span></td>
        <td>${b.ahead ? `<b>${b.ahead} new commit${b.ahead === 1 ? '' : 's'}</b> to merge` : b.dirty ? 'Nothing new to merge' : 'Already in main'}${b.behind ? `<br><span class="muted">${b.behind} commit${b.behind === 1 ? '' : 's'} behind main</span>` : ''}${b.dirty ? '<br><span class="pill doing" title="The agent has changes it hasn\'t saved (committed) yet. They won\'t be merged until it does.">uncommitted</span>' : ''}${
          (b.conflicts ? '<br><span class="pill conflict" title="Merging now would clash with changes already in main (both changed the same lines). Click Sync, and the agent will be asked to fix it.">will conflict</span>' : '') +
          scopePill(b)
        }</td>
        <td class="muted">${esc(b.lastCommit)}</td>
        <td><div class="branch-actions">
          ${b.ahead || b.dirty ? `<button data-diff="${esc(b.agentId)}" title="See exactly what this agent changed, line by line.">View changes</button>` : ''}
          ${b.ahead ? `<button data-merge="${esc(b.agentId)}" title="Put this agent's finished work into the main version of the code.">Merge</button>` : ''}
          ${b.behind ? `<button data-sync="${esc(b.agentId)}" title="Bring the latest main version (everyone's merged work) into this agent's copy, so it builds on top of it.">Sync</button>` : ''}
          ${b.ahead || b.dirty || b.behind ? '' : '<span class="muted">nothing to do</span>'}
        </div></td></tr>`,
    )
    .join('')}</tbody></table>`;
}

/** Files this agent changed that belong to someone else's task, or that none of its tasks claim. */
/** Dependencies, and whether they're accepted yet. */
function afterCell(t, tasks) {
  const deps = Array.isArray(t.after) ? t.after.filter((d) => typeof d === 'string') : [];
  if (!deps.length) return '<span class="muted">—</span>';
  const accepted = (id) => {
    const d = tasks.find((x) => x.id === id);
    if (!d) return true;
    const rec = state.reviews?.[id];
    return d.status === 'done' && (!rec || rec.status === 'passed');
  };
  const open = deps.filter((d) => !accepted(d));
  const pill = t.status === 'done' ? '' : open.length
    ? `<span class="pill doing" title="Waits for ${esc(open.join(', '))} to be accepted.">waiting</span>`
    : '<span class="pill done" title="Everything it depends on is accepted.">ready</span>';
  const label = (d) =>
    tasks.some((x) => x.id === d) ? esc(d) : `<span class="muted" title="There's no task ${esc(d)}, so this is ignored. Check the id in tasks.json.">${esc(d)}?</span>`;
  return `${deps.map(label).join(', ')} ${pill}`;
}

/** The task's hand-off note (what was built, files, decisions), for the title tooltip. */
function handoffTip(t) {
  const h = t.handoff;
  if (!h) return '';
  const text = typeof h === 'string' ? h : Object.entries(h).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
  return `Hand-off note:\n${text}`;
}

/** Review progress for one task, with its history in the tooltip and your override buttons. */
function reviewCell(t) {
  const rec = state.reviews?.[t.id];
  if (!rec) return '<span class="muted">—</span>';
  const stage = rec.stages[Math.min(rec.stage, rec.stages.length - 1)];
  const label =
    rec.status === 'passed' ? 'accepted ✓'
    : rec.status === 'stuck' ? 'stuck: your call'
    : rec.status === 'changes' ? `changes requested (round ${rec.rounds})`
    : stage === 'tests' ? 'running tests'
    : stage === 'desktop' ? (state.desktopTests?.run?.task === t.id ? 'running desktop tests' : 'desktop tests: press Run now')
    : rec.waitingOn ? `${STAGE_LABELS[stage]} · ${nameOf(rec.waitingOn)}`
    : `${STAGE_LABELS[stage]} · waiting for reviewer`;
  const cls = { passed: 'passed', stuck: 'stuck', changes: 'changes', in_review: 'review' }[rec.status];
  const history = rec.history
    .map((h) => `${nameOf(h.by)} · ${STAGE_LABELS[h.stage]} · ${h.verdict}${h.notes ? `: ${h.notes.slice(0, 160).replace(/\s+/g, ' ')}` : ''}`)
    .join('\n');
  const tip = `Stages: ${rec.stages.map((s) => STAGE_LABELS[s]).join(' → ')}${history ? `\n\n${history}` : ''}`;
  const btn = (action, text, title) => `<button data-review-action="${action}" data-task="${esc(t.id)}" title="${esc(title)}">${text}</button>`;
  const actions =
    rec.status === 'passed'
      ? btn('restart', 'Re-review', 'Run the whole review chain again for this task.')
      : btn('approve', 'Approve', 'Accept this task now, skipping the remaining review steps.') +
        btn('send_back', 'Send back', 'Return it to its builder with your note.') +
        btn('restart', 'Restart', 'Start this task’s review over from the first step.') +
        reviewBy(t, rec, stage);
  return `<span class="pill ${cls}" title="${esc(tip)}">${esc(label)}</span><div class="review-actions">${actions}</div>`;
}

/** "Change builder": hand the task to another agent; its review starts over. Not for accepted tasks. */
function builderSelect(t) {
  if (state.reviews?.[t.id]?.status === 'passed') return '';
  const who = state.agents.filter((a) => a.id !== t.owner && !a.disabled && !(a.outUntil && a.outUntil > Date.now()));
  if (!who.length) return '';
  return `<br><select class="builder-select" data-set-owner="${esc(t.id)}" title="Give this task to another builder, e.g. when ${esc(nameOf(t.owner ?? ''))} is out of usage. Its review starts over, so earlier send-backs don't count against the new builder.">
    <option value="">Change builder…</option>${who.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>`;
}

/** "Review by": pick who does the current review stage, e.g. when the usual reviewer is out of usage. */
function reviewBy(t, rec, stage) {
  if (rec.status !== 'in_review' || stage === 'tests' || stage === 'desktop') return '';
  // Not the builder, not whoever already approved a stage this round, and only agents that are available.
  // This round starts after the last send-back, or when the builder last reopened it (roundStart).
  const from = Math.max(rec.history.map((h) => h.verdict).lastIndexOf('changes') + 1, rec.roundStart ?? 0);
  const done = rec.history.slice(from).filter((h) => h.verdict === 'approve').map((h) => h.by);
  const who = state.agents.filter((a) => a.id !== t.owner && a.id !== rec.waitingOn && !done.includes(a.id) && !a.disabled && !(a.outUntil && a.outUntil > Date.now()));
  if (!who.length) return '';
  return `<select data-review-by="${esc(t.id)}" title="Have someone else do this ${esc(STAGE_LABELS[stage])} now, e.g. when the usual reviewer is out of usage.">
    <option value="">Review by…</option>${who.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>`;
}

const STATUS_TIPS = {
  todo: 'Not started yet.',
  doing: 'In progress.',
  done: 'Finished.',
  blocked: "Stuck: needs a decision from you or a teammate's work. See the note.",
};

function scopePill(b) {
  const list = [...(b.foreign ?? []).map((f) => `${f.file} → ${nameOf(f.owner)}'s ${f.task}`), ...(b.outside ?? []).map((f) => `${f} → no task claims it`)];
  if (!list.length) return '';
  const tip = `This agent changed files outside the area its tasks own, which can clash with another agent's work:\n${list.join('\n')}`;
  return `<br><span class="pill doing" title="${esc(tip)}">${list.length} outside its area</span>`;
}

function showDiff(agentId) {
  diffAgent = agentId;
  $('#branchList').hidden = Boolean(agentId);
  $('#diffView').hidden = !agentId;
  if (!agentId) return;
  $('#diffTitle').textContent = `agent/${agentId} vs main`;
  $('#diffBody').innerHTML = '<div class="empty">Loading diff…</div>';
  send({ type: 'get_diff', agentId });
}

function renderDiff(d) {
  lastDiff = d;
  commentsKey = JSON.stringify(state.comments ?? []);
  const scroller = $('#tab-branches');
  const top = scroller.scrollTop;
  $('#diffBody').innerHTML =
    commentPanel(d.agentId) + diffHtml(d, 'Committed: what Merge will bring into main', 'Uncommitted in the worktree (not merged until the agent commits)', d.agentId);
  $('#diffMerge').disabled = !d.committed;
  scroller.scrollTop = top;
}

/** Comments on this branch: open ones can be sent to the builder in one message. */
function commentPanel(agentId) {
  const all = (state.comments ?? []).filter((c) => c.agent === agentId);
  const pending = all.filter((c) => c.status !== 'resolved');
  const hint = '<div class="muted comment-hint">Click any line in the diff to leave a comment on it.</div>';
  if (!all.length) return hint;
  const name = nameOf(agentId);
  const rows = all
    .map(
      (c) => `<div class="comment-row ${c.status}"><b>${esc(c.id)}</b> <span class="mono">${esc(c.file)}:${c.line}</span> ${esc(c.text)}
        <span class="pill ${c.status === 'resolved' ? 'done' : c.status === 'sent' ? 'doing' : ''}" title="${c.status === 'sent' ? `Sent ${c.rounds}×; waiting for ${esc(name)} to fix it.` : c.status === 'resolved' ? 'Done.' : 'Not sent yet.'}">${c.status}</span>
        <span class="muted">${c.by === 'user' ? 'you' : esc(nameOf(c.by))}</span>
        ${c.status === 'resolved'
          ? `<button data-comment="reopen" data-id="${esc(c.id)}" title="Not actually fixed: send it again with the next batch.">Reopen</button>`
          : `<button data-comment="resolve" data-id="${esc(c.id)}" title="Mark it done; it won't be sent again.">Resolve</button>`}
        <button data-comment="delete" data-id="${esc(c.id)}" class="danger" title="Remove this comment.">Delete</button></div>`,
    )
    .join('');
  const send = pending.length
    ? `<button data-send-comments="${esc(agentId)}" title="Send every comment that isn't resolved to ${esc(name)} as one change request. Ones it doesn't mark fixed go again next time.">Send ${pending.length} to ${esc(name)}</button>`
    : '';
  return `<div class="comment-panel"><div class="comment-head"><b>Comments</b> <span class="muted">${pending.length} open</span> ${send}</div>${rows}</div>${hint}`;
}

function diffHtml(d, committedLabel, uncommittedLabel, agent) {
  const parts = [];
  if (d.stat) parts.push(`<pre class="diff-stat">${esc(d.stat)}</pre>`);
  if (d.truncated) parts.push('<div class="empty">Diff is very large and was cut off. Open the folder in your editor for the rest.</div>');
  parts.push(`<div class="diff-section">${esc(committedLabel)}</div>`);
  parts.push(d.committed ? diffFiles(d.committed, agent) : '<div class="empty">No committed changes.</div>');
  if (d.uncommitted) {
    parts.push(`<div class="diff-section">${esc(uncommittedLabel)}</div>`);
    parts.push(diffFiles(d.uncommitted, agent));
  }
  return parts.join('');
}

// ── App helper ─────────────────────────────────────────────────────────

/** Full redraw on state; `scroll` jumps to the newest message. */
function renderHelper(scroll) {
  $('#helperEdit').checked = helper.editMode;
  $('#helperOperate').checked = Boolean(helper.operate);
  $('#helperEdit').disabled = !helper.gitOk;
  $('#helperEdit').parentElement.title = helper.gitOk
    ? "Let the helper change the app's code. Changes wait on their own branch until you apply them."
    : 'The app folder is not a git repository, so the helper can only read and explain.';
  renderHelperPause();
  renderHelperAttention();
  setHelperStatus(helper.status);
  const box = $('#helperMessages');
  box.innerHTML = '';
  if (!helper.messages.length) {
    box.innerHTML = `<div class="empty">Chat with the helper about this app any time: what something does, why it isn't working, or a feature you'd like.
It sees the server log and any errors you've seen. With <b>Allow edits</b> on it can change the app; nothing changes until you click <b>Apply &amp; restart</b>.</div>`;
  }
  helper.messages.forEach(appendHelperMessage);
  if (scroll) box.scrollTop = box.scrollHeight;

  const c = helper.changes;
  const bar = $('#helperChanges');
  const parts = [];
  if (c.files.length) {
    parts.push(`<span title="${esc('Files the helper changed:\n' + c.files.join('\n'))}"><b>${c.files.length} file${c.files.length === 1 ? '' : 's'} changed</b>, not applied yet</span>
      <button id="helperViewDiff" title="See exactly what the helper changed, line by line.">View changes</button>
      <button id="helperApply" title="Check the changes for errors, put them into the app, and restart it. The page reloads by itself. If the app then fails to start, it goes back automatically.">Apply &amp; restart</button>
      <button id="helperDiscard" class="danger" title="Throw away the helper's changes. The running app isn't affected.">Discard</button>`);
  }
  if (helper.undoAvailable) parts.push(`<button id="helperUndo" title="Go back to the version of the app from before the last update you applied, and restart.">Undo last update</button>`);
  bar.innerHTML = parts.join('');
  bar.hidden = !parts.length;
  $('#helperApply')?.addEventListener('click', () => {
    if (confirm(helper.supervised ? 'Apply the changes and restart the app?' : 'Apply the changes? You will need to restart the app yourself.')) send({ type: 'helper_apply' });
  });
  $('#helperDiscard')?.addEventListener('click', () => confirm('Throw away the helper’s unapplied changes?') && send({ type: 'helper_discard' }));
  $('#helperUndo')?.addEventListener('click', () => confirm('Undo the last update and restart?') && send({ type: 'helper_undo' }));
  $('#helperViewDiff')?.addEventListener('click', () => {
    $('#helperDiff').hidden = false;
    $('#helperMessages').hidden = true;
    $('#helperDiffBody').innerHTML = '<div class="empty">Loading…</div>';
    send({ type: 'helper_diff' });
  });
}

function appendHelperMessage(m) {
  const box = $('#helperMessages');
  box.querySelector('.empty')?.remove();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const el = document.createElement('div');
  el.className = `msg ${m.from === 'user' ? 'user' : m.from === 'system' ? 'system' : 'helper'}`;
  if (m.from === 'system') {
    const previous = box.lastElementChild;
    if (previous?.dataset.notice === m.text) {
      const count = Number(previous.dataset.count ?? 1) + 1;
      previous.dataset.count = String(count);
      previous.textContent = `${m.text} ×${count}`;
      if (atBottom) box.scrollTop = box.scrollHeight;
      return;
    }
    el.dataset.notice = m.text;
    el.textContent = m.text;
  }
  else {
    el.innerHTML = `<div class="who">${m.from === 'user' ? 'You' : 'App helper'}</div><div class="body"></div>`;
    el.querySelector('.body').textContent = m.text;
    if (m.attachments?.length) el.appendChild(attachmentsEl('helper', m.attachments));
  }
  box.appendChild(el);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderHelperPause() {
  const pause = helper.automaticPause;
  const paused = helper.operate && pause && (pause.until === 'message' || pause.until > Date.now());
  const bar = $('#helperPause');
  bar.hidden = !paused;
  bar.textContent = !paused ? '' : pause.until === 'message'
    ? 'Run my project: paused until you message the helper (usage limit)'
    : `Run my project: paused until ${fmtClock(pause.until)} (${pause.reason === 'hourly' ? 'hourly check cap' : 'usage limit'})`;
}

function setHelperStatus(status) {
  helper.status = status;
  $('#helperDot').className = `dot ${status}`;
  $('#helperStop').hidden = status !== 'working';
  if (status !== 'working') $('#helperActivity').textContent = '';
}

function onHelperEvent(ev) {
  if (ev.kind === 'status') return setHelperStatus(ev.status);
  if (ev.kind === 'tool') $('#helperActivity').textContent = `▸ ${ev.name} ${ev.detail}`;
}

function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${tab}`));
  if (tab === 'agents') stickLogs();
}

/** Agent boxes that follow new output jump to their newest line (after a reload, or when the tab is shown). */
function stickLogs() {
  for (const log of document.querySelectorAll('#agentList .log')) if (log.dataset.stick !== '0') log.scrollTop = log.scrollHeight;
}

/** From an error in the room: open the helper with the problem filled in (you still press Ask). */
function askHelper(problem) {
  showTab('helper');
  setMobileView('workspace');
  $('#helperInput').value = `This showed up in the app: "${problem}"\nWhat does it mean, and how do I fix it?`;
  $('#helperInput').focus();
}

/** Split a unified diff into collapsible per-file blocks with +/- line coloring. */
/** With `agent`, lines are clickable to comment on, numbered, and show that branch's comments inline. */
function diffFiles(text, agent) {
  const comments = agent ? (state.comments ?? []).filter((c) => c.agent === agent) : [];
  return text
    .split(/^(?=diff --git )/m)
    .filter((f) => f.trim())
    .map((f) => {
      const lines = f.replace(/\n$/, '').split('\n');
      const name = (lines[0].match(/ b\/(.+)$/) ?? [, lines[0]])[1];
      const adds = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      const dels = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
      let oldNo = 0;
      let newNo = 0;
      let inHunk = false;
      const body = lines
        .slice(1)
        .map((l) => {
          const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+++') || l.startsWith('---') ? 'meta' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : /^(index |new file|deleted file|similarity|rename|old mode|new mode|Binary)/.test(l) ? 'meta' : '';
          if (cls === 'hunk') {
            const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
            if (h) [oldNo, newNo, inHunk] = [Number(h[1]), Number(h[2]), true];
            return `<div class="${cls}">${esc(l)}</div>`;
          }
          if (!agent || !inHunk || cls === 'meta' || l.startsWith('\\')) return `<div class="${cls}">${esc(l) || ' '}</div>`;
          const side = cls === 'del' ? 'old' : 'new';
          const no = side === 'old' ? oldNo++ : newNo++;
          if (cls === '') oldNo++;
          const here = comments.filter((c) => c.file === name && c.line === no && c.side === side);
          const notes = here.map((c) => `<div class="inline-comment ${c.status}"><b>${esc(c.id)}</b> ${esc(c.text)} <span class="muted">· ${c.status}</span></div>`).join('');
          return `<div class="${cls} cl" data-file="${esc(name)}" data-line="${no}" data-side="${side}" title="Click to comment on this line."><span class="ln">${no}</span>${esc(l) || ' '}</div>${notes}`;
        })
        .join('');
      return `<details class="diff-file" open><summary>${esc(name)} <span class="muted">+${adds} −${dels}</span></summary><pre>${body}</pre></details>`;
    })
    .join('');
}

$('#diffBody').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-comment]');
  if (action) return send({ type: 'comment_action', id: action.dataset.id, action: action.dataset.comment });
  const sendBtn = e.target.closest('[data-send-comments]');
  if (sendBtn) return send({ type: 'send_comments', agentId: sendBtn.dataset.sendComments });
  const line = e.target.closest('.cl');
  if (!line || !diffAgent) return;
  const code = line.textContent.replace(/^\d+/, '').slice(1);
  const text = await askText(`Comment on ${line.dataset.file}:${line.dataset.line}\n${code.trim().slice(0, 100)}`, '', true);
  if (text?.trim()) send({ type: 'add_comment', agentId: diffAgent, file: line.dataset.file, line: Number(line.dataset.line), side: line.dataset.side, lineText: code, text });
});

/**
 * An in-page text box in place of prompt(), which the app's browser pane blocks. Resolves to the text,
 * or null on Cancel / Esc. Enter is OK (Shift+Enter is a new line in multi-line boxes).
 */
function askText(question, value = '', multiline = false) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'plan-review ask-text';
    dlg.innerHTML = '<div class="plan-review-head ask-question"></div><div class="ask-body"></div><div class="plan-review-actions"><button type="button" data-ask="cancel">Cancel</button><button type="button" data-ask="ok">OK</button></div>';
    dlg.querySelector('.ask-question').textContent = question;
    const input = document.createElement(multiline ? 'textarea' : 'input');
    input.value = value;
    if (multiline) input.rows = 4;
    dlg.querySelector('.ask-body').appendChild(input);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.querySelector('[data-ask="ok"]').onclick = () => finish(input.value);
    dlg.querySelector('[data-ask="cancel"]').onclick = () => finish(null);
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
        e.preventDefault();
        finish(input.value);
      }
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    input.focus();
    input.select();
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ── Controls ───────────────────────────────────────────────────────────

// A block body on purpose: an on* handler that returns false cancels the key, so nothing could be typed.
$('#newProject').onkeydown = (e) => {
  if (e.key === 'Enter') $('#createProject').click();
};
$('#createProject').onclick = () => {
  const name = $('#newProject').value.trim();
  if (name) send({ type: 'create_project', name });
  $('#newProject').value = '';
};
$('#projectSelect').onchange = (e) => e.target.value && send({ type: 'open_project', name: e.target.value });
$('#leaderSelect').onchange = (e) => send({ type: 'set_leader', leader: e.target.value });
$('#phases').onclick = (e) => {
  const phase = e.target.dataset.phase;
  if (!phase) return;
  if (phase === 'build' && state.phase === 'plan') return showPlanReview({ start: () => send({ type: 'set_phase', phase }) });
  send({ type: 'set_phase', phase });
};
$('#gates').onchange = (e) => send({ type: 'set_gates', on: e.target.checked });
$('#autopilot').onchange = (e) => send({ type: 'set_autopilot', on: e.target.checked });
$('#stopAll').onclick = () => send({ type: 'stop_all' });
$('#tab-agents').onclick = (e) => e.target.dataset.stop && send({ type: 'stop', agentId: e.target.dataset.stop });
$('#requests').onclick = async (e) => {
  if (e.target.dataset.limitApply !== undefined) {
    const name = $('#requests [data-limit-preset]')?.value;
    if (name) send({ type: 'apply_preset', name });
    return;
  }
  if (e.target.dataset.limitDismiss !== undefined) return send({ type: 'dismiss_limit' });
  if (e.target.dataset.desktop) {
    const { desktop: action, task } = e.target.dataset;
    if (action === 'skip' && !confirm(`Accept ${task} without its desktop tests?`)) return;
    return send({ type: 'desktop_tests', action, taskId: task });
  }
  if (e.target.dataset.resume) return send({ type: 'resume_action', action: e.target.dataset.resume });
  if (e.target.dataset.stall) return send({ type: 'stall_action', agentId: e.target.dataset.agent, action: e.target.dataset.stall });
  if (e.target.dataset.needsOption) {
    const { needsOption: agent, option } = e.target.dataset;
    // The leader asking "start Build?" and you answering yes: go straight to the plan check (one decision, not three).
    if (agent === state.leader && state.phase === 'plan' && /\b(start|begin|go)\b.*\bbuild\b|^build\b/i.test(option)) {
      return showPlanReview({
        start: () => {
          send({ type: 'dismiss_needs_you', agentId: agent });
          send({ type: 'set_phase', phase: 'build' });
        },
      });
    }
    return send({ type: 'send', to: agent, text: option });
  }
  if (e.target.dataset.needsDismiss) return send({ type: 'dismiss_needs_you', agentId: e.target.dataset.needsDismiss });
  if (e.target.dataset.needsReply) {
    $('#toSelect').value = 'all';
    $('#input').value = `@${e.target.dataset.needsReply} ` + $('#input').value.replace(/^@\S+\s*/, '');
    $('#input').focus();
    return;
  }
  const { approve, reject } = e.target.dataset;
  const req = state.requests.find((r) => r.id === (approve ?? reject));
  if (!req) return;
  if (approve) {
    // Starting Build: look over the plan, tasks and file areas first.
    if (req.kind === 'phase' && req.value === 'build') {
      return showPlanReview({
        start: () => send({ type: 'resolve_request', id: req.id, approve: true }),
        sendBack: (reason) => send({ type: 'resolve_request', id: req.id, approve: false, reason }),
      });
    }
    if (req.kind === 'merge' && !confirmMerge(req.value)) return;
    return send({ type: 'resolve_request', id: req.id, approve: true });
  }
  const reason = await askText(`Why not? ${nameOf(req.from)} gets your reason and can fix it and ask again. (Leave empty to just say no.)`, '', true);
  if (reason === null) return;
  send({ type: 'resolve_request', id: req.id, approve: false, reason });
};

/** Tasks of this agent that aren't accepted yet: "t2 (in review)", "t4 (doing)". */
function unaccepted(agentId) {
  let tasks = [];
  try {
    tasks = JSON.parse(team.tasks || '{}').tasks ?? [];
  } catch {}
  return tasks
    .filter((t) => t.owner === agentId)
    .map((t) => {
      if (t.status !== 'done') return `${t.id} (${t.status ?? 'todo'})`;
      const rec = state.reviews?.[t.id];
      if (state.reviewMode !== 'off' && rec?.status !== 'passed') return `${t.id} (${rec ? rec.status.replace('_', ' ') : 'not reviewed'})`;
      return '';
    })
    .filter(Boolean);
}

/** Merging work that isn't accepted yet needs a second "yes". */
function confirmMerge(agentId) {
  const open = unaccepted(agentId);
  return !open.length || confirm(`agent/${agentId} has work that isn't accepted yet: ${open.join(', ')}.\nMerge it into main anyway?`);
}

/** Before Build: the plan, who does what, and which files each task owns, with Start / Send back. */
function showPlanReview({ start, sendBack }) {
  const dlg = $('#planReview');
  let tasks = [];
  try {
    tasks = JSON.parse(team.tasks || '{}').tasks ?? [];
  } catch {}
  const rows = tasks
    .map(
      (t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.title ?? '')}</td><td>${esc(nameOf(t.owner ?? ''))}</td>
        <td><code>${esc((Array.isArray(t.files) ? t.files : []).join(', ') || 'any')}</code></td>
        <td>${esc((Array.isArray(t.after) ? t.after : []).join(', ') || '—')}</td></tr>`,
    )
    .join('');
  const owners = new Set(tasks.map((t) => t.owner).filter(Boolean));
  const idle = (state.agents ?? []).filter((a) => !owners.has(a.id)).map((a) => a.name);
  const warn = [
    !tasks.length ? 'tasks.json has no tasks: agents will have nothing to build.' : '',
    tasks.some((t) => !Array.isArray(t.files) || !t.files.length) ? 'Some tasks have no "files", so edits outside an area won\'t be caught for them.' : '',
    (team.overlaps ?? []).length ? `${team.overlaps.length} possible file overlap(s) between agents (see the Tasks tab).` : '',
    idle.length ? `No tasks for: ${idle.join(', ')}.` : '',
  ].filter(Boolean);
  $('#planReviewBody').innerHTML = `
    ${warn.length ? `<ul class="plan-warn">${warn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <h4>Tasks (${tasks.length})</h4>
    <table class="tasks"><thead><tr><th>ID</th><th>Task</th><th>Owner</th><th>Files</th><th>After</th></tr></thead><tbody>${rows}</tbody></table>
    <h4>Review: ${esc({ off: 'off', chain: 'role chain', cross: 'any other agent' }[$('#reviewMode').value] ?? 'off')} · Tests: ${esc(state.testCommand || 'none')}${state.desktopTests?.command ? ` · Desktop tests: ${esc(state.desktopTests.command)}` : ''} · Autopilot: ${$('#autopilot').checked ? 'on' : 'off'}</h4>
    <h4>PLAN.md</h4><pre class="plan-text">${esc(team.plan || '(empty)')}</pre>`;
  $('#planReviewReason').value = '';
  $('#planReviewStart').onclick = () => {
    dlg.close();
    start();
  };
  $('#planReviewBack').onclick = () => {
    const reason = $('#planReviewReason').value.trim();
    if (!reason) return $('#planReviewReason').focus();
    dlg.close();
    sendBack(reason);
  };
  $('#planReviewBack').hidden = !sendBack;
  $('#planReviewReason').hidden = !sendBack;
  dlg.showModal();
}
$('#tab-branches').onclick = (e) => {
  const { merge, sync, diff } = e.target.dataset;
  if (diff) showDiff(diff);
  if (merge && confirmMerge(merge)) send({ type: 'merge', agentId: merge });
  if (sync) send({ type: 'sync', agentId: sync });
};

$('#diffBack').onclick = () => showDiff(null);
$('#diffMerge').onclick = () => {
  if (!confirmMerge(diffAgent)) return;
  send({ type: 'merge', agentId: diffAgent });
  showDiff(null);
};
$('#resetUsage').onclick = () => confirm('Reset token and cost counters for this project?') && send({ type: 'reset_usage' });

// ── Setup → Agents: add, remove or change the team ─────────────────────
let agentConfig = null;
let agentsDirty = false;
let agentsSaving = false;
const ADAPTER_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex CLI (also local models)',
  grok: 'Grok CLI',
  hermes: 'Hermes Agent',
  generic: 'Other CLI (generic)',
  mock: 'Mock (testing)',
};
const ADAPTER_HINTS = {
  claude: 'Runs `claude`. Sign in once with `claude` in a terminal.',
  codex: 'Runs `codex`. For a model on your own computer or another one on your network (LM Studio, Ollama, llama.cpp), fill in Model server and the model name.',
  grok: 'Runs `grok`. Sign in once with `grok` in a terminal.',
  hermes: 'Runs `hermes`. Models come from your Hermes config; sign in with `hermes model`.',
  generic: 'Any CLI that takes a prompt and prints a reply, e.g. aider or opencode. The prompt goes on stdin; put {promptFile} in Extra options if it reads a file instead (aider: --yes-always --message-file {promptFile}).',
  mock: 'Fake agent for testing the app.',
};
/** Placeholder for Extra options: an example that fits the program (nothing where options are rarely needed). */
const ARGS_EXAMPLES = { generic: 'e.g. --yes-always --message-file {promptFile}' };
const PALETTE = ['#d97757', '#10a37f', '#8b8bf5', '#e0a030', '#3fa7d6', '#c75fb0', '#7fb069', '#e06060'];
const splitArgs = (s) => (s.match(/"[^"]*"|\S+/g) || []).map((w) => w.replace(/^"|"$/g, ''));
const joinArgs = (a) => (a || []).map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(' ');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 32);

function agentRow(a, isNew) {
  const row = document.createElement('div');
  row.className = 'agent-row';
  row.dataset.orig = JSON.stringify(a);
  row.dataset.isNew = isNew ? '1' : '';
  row.style.setProperty('--agent-color', a.color || '#888');
  const opts = agentConfig.adapters.map((k) => `<option value="${k}"${k === a.adapter ? ' selected' : ''}>${esc(ADAPTER_LABELS[k] || k)}</option>`).join('');
  row.innerHTML = `
    <label title="Color used for this agent in the chat."><span>Color</span><input type="color" data-f="color" value="${esc(a.color || '#888888')}"></label>
    <label title="Shown in the chat and used to @mention the agent."><span>Name</span><input data-f="name" maxlength="40" value="${esc(a.name || '')}"></label>
    <label title="Which kind of program this is; picks how the app talks to it."><span>Program</span><select data-f="adapter">${opts}</select></label>
    <label title="The command to run, as you'd type it in a terminal (no spaces)."><span>Command</span><input data-f="command" value="${esc(a.command || '')}" placeholder="e.g. codex"></label>
    <button class="small danger" data-remove title="Remove this agent from the team. Its branch and copy of the project stay on disk.">Remove</button>
    <label class="wide" title="Options added to every run, separated by spaces. Quote an option that has spaces."><span>Extra options (optional)</span><input data-f="args" value="${esc(joinArgs(a.args))}" placeholder="${esc(ARGS_EXAMPLES[a.adapter] || '')}"></label>
    <label title="Default model; you can still change it per project on the Agents tab. Empty = the program's default."><span>Default model (optional)</span><input data-f="model" value="${esc(a.model || '')}"></label>
    <label data-profile-field title="Hermes only. The profile this agent runs as by default; each profile has its own default model, memory and skills. You can still change it per project on the Agents tab. Empty = the profile Hermes has active."><span>Hermes profile (optional)</span><input data-f="profile" value="${esc(a.profile || '')}" placeholder="e.g. coder" list="hermesProfiles"></label>
    <label class="wide" data-server-field title="Codex only. The address of a model server on this computer or your network (LM Studio, Ollama, llama.cpp…). The server must offer the OpenAI Responses API. Empty = OpenAI's models."><span>Model server (optional)</span><input data-f="server" value="${esc(a.server || '')}" placeholder="e.g. http://192.168.1.50:1234/v1 (LM Studio) or http://localhost:11434/v1 (Ollama)"></label>
    <label class="stuck" title="How long this agent may go without any output before the app says it may be stuck. Local models are slow: 30 minutes is the default with a model server, 6 without."><span>Stuck warning after (min)</span><input data-f="stuckMinutes" type="number" min="1" max="600" value="${esc(a.stuckMinutes ?? '')}" placeholder="${a.server ? 30 : 6}"></label>
    <div class="hint"></div>`;
  const hint = (adapter) => {
    row.querySelector('.hint').innerHTML = `${isNew ? '' : `id: <code>${esc(a.id)}</code> · `}${esc(ADAPTER_HINTS[adapter] || '').replace(/`([^`]+)`/g, '<code>$1</code>')}`;
  };
  hint(a.adapter);
  const serverField = row.querySelector('[data-server-field]');
  const profileField = row.querySelector('[data-profile-field]');
  const showServer = (adapter) => {
    serverField.hidden = adapter !== 'codex';
    profileField.hidden = adapter !== 'hermes';
  };
  showServer(a.adapter);
  // The default stuck limit follows whether a server is filled in.
  row.querySelector('[data-f=server]').oninput = (e) => (row.querySelector('[data-f=stuckMinutes]').placeholder = e.target.value.trim() ? '30' : '6');
  row.querySelector('[data-remove]').onclick = () => {
    row.remove();
    agentsDirty = true;
  };
  row.querySelector('[data-f=adapter]').onchange = (e) => {
    const cmd = row.querySelector('[data-f=command]');
    const prev = JSON.parse(row.dataset.orig).adapter;
    if (!cmd.value || cmd.value === prev || cmd.value === row.dataset.lastAdapter) cmd.value = e.target.value === 'generic' ? '' : e.target.value;
    row.dataset.lastAdapter = e.target.value;
    hint(e.target.value);
    showServer(e.target.value);
    row.querySelector('[data-f=args]').placeholder = ARGS_EXAMPLES[e.target.value] || '';
  };
  row.querySelector('[data-f=color]').oninput = (e) => row.style.setProperty('--agent-color', e.target.value);
  row.oninput = () => (agentsDirty = true);
  return row;
}

function renderAgentRows(agents) {
  const box = $('#agentsRows');
  box.innerHTML = '';
  for (const a of agents) box.append(agentRow(a, false));
}

function readAgentRows() {
  const rows = [...document.querySelectorAll('#agentsRows .agent-row')];
  const used = new Set(rows.filter((r) => !r.dataset.isNew).map((r) => JSON.parse(r.dataset.orig).id));
  return rows.map((row) => {
    const orig = JSON.parse(row.dataset.orig);
    const v = (f) => row.querySelector(`[data-f=${f}]`).value.trim();
    const a = { ...orig, name: v('name'), adapter: v('adapter'), command: v('command'), color: v('color') };
    const args = splitArgs(v('args'));
    if (args.length) a.args = args;
    else delete a.args;
    if (v('model')) a.model = v('model');
    else delete a.model;
    // A model server is a Codex setting; another program drops it.
    if (a.adapter === 'codex' && v('server')) a.server = v('server');
    else delete a.server;
    // So is a profile for Hermes.
    if (a.adapter === 'hermes' && v('profile')) a.profile = v('profile');
    else delete a.profile;
    const stuck = v('stuckMinutes');
    if (stuck) a.stuckMinutes = Number(stuck);
    else delete a.stuckMinutes;
    // A changed program keeps no model/effort picked for the old one.
    if (orig.adapter && orig.adapter !== a.adapter) {
      if (!v('model') || v('model') === orig.model) delete a.model;
      delete a.effort;
    }
    if (row.dataset.isNew) {
      // Taken from the name; a removed agent's id may come back (it gets its old branch back).
      const base = slug(a.name) || a.adapter;
      let id = base;
      for (let n = 2; used.has(id) || ['user', 'all', 'helper'].includes(id); n++) id = `${base}-${n}`;
      a.id = id;
      used.add(id);
    }
    return a;
  });
}

$('#agentsEdit').onclick = () => {
  if (!agentConfig) return send({ type: 'get_agent_config' });
  agentsDirty = false;
  $('#agentsError').hidden = true;
  renderAgentRows(agentConfig.agents);
  $('#agentsDialog').showModal();
  send({ type: 'get_agent_config' });
};
$('#agentsAdd').onclick = () => {
  const n = document.querySelectorAll('#agentsRows .agent-row').length;
  const row = agentRow({ name: `Agent ${n + 1}`, adapter: 'codex', command: 'codex', color: PALETTE[n % PALETTE.length], autonomy: 'edits' }, true);
  $('#agentsRows').append(row);
  row.querySelector('[data-f=name]').select();
  agentsDirty = true;
};
$('#agentsSave').onclick = () => {
  if (agentsSaving) return;
  $('#agentsError').hidden = true;
  const agents = readAgentRows();
  const gone = agentConfig.agents.filter((a) => !agents.some((b) => b.id === a.id)).map((a) => a.name);
  if (gone.length && !confirm(`Remove ${gone.join(', ')} from the team? Their branch and copy of the project stay on disk.`)) return;
  agentsSaving = true;
  send({ type: 'save_agent_config', agents });
};

function setMobileView(view) {
  $('main').dataset.view = view;
  document.querySelectorAll('#mobileViews button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
    b.setAttribute('aria-pressed', String(b.dataset.view === view));
  });
}
$('#mobileViews').onclick = (e) => {
  if (e.target.dataset.view) setMobileView(e.target.dataset.view);
};
try { $('#setupPanel').hidden = localStorage.getItem('tts-setup-open') !== 'true'; } catch {}
$('#setupToggle').setAttribute('aria-expanded', String(!$('#setupPanel').hidden));
$('#setupToggle').onclick = () => {
  const panel = $('#setupPanel');
  panel.hidden = !panel.hidden;
  $('#setupToggle').setAttribute('aria-expanded', String(!panel.hidden));
  try { localStorage.setItem('tts-setup-open', String(!panel.hidden)); } catch {}
};

$('#tabs').onclick = (e) => {
  const tab = e.target.dataset.tab;
  if (tab) showTab(tab);
  if (tab === 'branches') send({ type: 'refresh_branches' });
  if (tab === 'helper') $('#helperMessages').scrollTop = $('#helperMessages').scrollHeight;
};

$('#helperForm').onsubmit = (e) => {
  e.preventDefault();
  if (helperAttach.busy()) return alert('Still uploading an image, one moment…');
  const text = $('#helperInput').value.trim();
  const attachments = helperAttach.names();
  if (!text && !attachments.length) return;
  $('#helperInput').value = '';
  helperAttach.clear();
  send({ type: 'helper_send', text, attachments });
};
$('#helperInput').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#helperForm').requestSubmit();
  }
};
$('#helperStop').onclick = () => send({ type: 'helper_stop' });
$('#helperEdit').onchange = (e) => send({ type: 'helper_edit', on: e.target.checked });
$('#helperOperate').onchange = (e) => send({ type: 'helper_operate', on: e.target.checked });
$('#helperNew').onclick = () => confirm('Start a new conversation with the helper?') && send({ type: 'helper_reset' });
$('#helperDiffBack').onclick = () => {
  $('#helperDiff').hidden = true;
  $('#helperMessages').hidden = false;
};

const setPlanEditing = (on) => {
  editingPlan = on;
  $('#planView').hidden = on;
  $('#planEdit').hidden = !on;
  $('#editPlan').hidden = on;
  $('#savePlan').hidden = !on;
  $('#cancelPlan').hidden = !on;
};
$('#editPlan').onclick = () => {
  if (!state.project) return;
  $('#planEdit').value = team.plan;
  setPlanEditing(true);
};
$('#cancelPlan').onclick = () => {
  setPlanEditing(false);
  renderPlan();
};
$('#savePlan').onclick = () => {
  send({ type: 'save_plan', plan: $('#planEdit').value });
  setPlanEditing(false);
};

const takeInput = () => {
  const text = $('#input').value.trim();
  $('#input').value = '';
  return text;
};
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  if (mainAttach.busy()) return alert('Still uploading an image, one moment…');
  const attachments = mainAttach.names();
  const text = takeInput();
  if (!text && !attachments.length) return;
  mainAttach.clear();
  send({ type: 'send', text, to: $('#toSelect').value, attachments });
};
$('#debate').onclick = () => {
  if (!$('#input').value.trim()) {
    $('#input').placeholder = 'Type the debate topic, then click Debate';
    return;
  }
  if (mainAttach.busy()) return alert('Still uploading a file, one moment…');
  const attachments = mainAttach.names();
  const text = takeInput();
  mainAttach.clear();
  send({ type: 'debate', text, attachments });
};
$('#input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
};

// ── Theme ──────────────────────────────────────────────────────────────

$('#theme').value = document.documentElement.dataset.theme ?? 'system';
$('#theme').onchange = (e) => {
  const t = e.target.value;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('tts-theme', t);
  } catch {}
};

// ── Image attachments (both chats) ─────────────────────────────────────

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXTS = ['png', 'jpg', 'gif', 'webp'];
/** Text files that can be attached (keep in sync with TEXT_EXTS in server/attachments.ts). */
const TEXT_EXTS = ['txt', 'md', 'log', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'scss', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'php', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'diff', 'patch', 'pine'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const extOf = (name) => (name.toLowerCase().match(/\.([a-z0-9]+)$/) ?? [])[1] ?? '';
/** "<uuid>__my-log.txt" → "my-log.txt"; pasted screenshots → "image.png". */
const attachmentLabel = (name) => {
  const m = name.match(/^[0-9a-f-]{36}(?:__(.+))?\.([a-z0-9]+)$/);
  return m ? `${m[1] ?? (IMAGE_EXTS.includes(m[2]) ? 'image' : 'file')}.${m[2]}` : name;
};

/**
 * Adds paste, drag-and-drop and 📎 attaching to a chat box. Images upload right away and show as
 * thumbnails in `tray`; names() gives what to send with the message.
 */
function makeAttacher({ scope, tray, button, fileInput, pasteTarget, dropTargets }) {
  const items = [];
  const render = () => {
    tray.hidden = !items.length;
    tray.innerHTML = '';
    items.forEach((it, i) => {
      const box = document.createElement('div');
      box.className = `attach-item${it.uploading ? ' uploading' : ''}${it.error ? ' error' : ''}`;
      box.title = it.error ?? `${it.label}: ${it.uploading ? 'uploading…' : 'will be sent with your next message'}`;
      let img;
      if (it.image) {
        img = document.createElement('img');
        img.src = it.preview;
        img.alt = it.label;
      } else {
        img = document.createElement('div');
        img.className = 'file-thumb';
        img.innerHTML = `<span>📄</span><small></small>`;
        img.querySelector('small').textContent = it.label;
      }
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove';
      rm.textContent = '×';
      rm.title = 'Remove this image';
      rm.onclick = () => {
        if (it.preview) URL.revokeObjectURL(it.preview);
        items.splice(i, 1);
        render();
      };
      box.append(img, rm);
      if (it.error) {
        const err = document.createElement('div');
        err.className = 'err';
        err.textContent = 'failed';
        box.appendChild(err);
      }
      tray.appendChild(box);
    });
  };
  const add = (files) => {
    for (const file of files) {
      const image = IMAGE_TYPES.includes(file.type);
      if (!image && !TEXT_EXTS.includes(extOf(file.name))) {
        alert(`"${file.name || 'That file'}" can't be attached. Images (PNG, JPG, GIF, WebP) and text files (${TEXT_EXTS.map((e) => '.' + e).join(' ')}) are supported.`);
        continue;
      }
      if (file.size > (image ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES)) {
        alert(`"${file.name}" is too big: ${image ? 'images can be up to 10 MB' : 'text files can be up to 2 MB'}.`);
        continue;
      }
      const it = { image, label: file.name || (image ? 'image' : 'file'), preview: image ? URL.createObjectURL(file) : '', uploading: true };
      items.push(it);
      fetch(`/api/attachments/${scope}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-tts': '1', 'x-filename': encodeURIComponent(file.name || '') },
        body: file,
      })
        .then(async (r) => {
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body.error ?? `Upload failed (${r.status})`);
          it.name = body.name;
        })
        .catch((e) => (it.error = e.message))
        .finally(() => {
          it.uploading = false;
          render();
        });
    }
    render();
  };

  button.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    add([...fileInput.files]);
    fileInput.value = '';
  };
  pasteTarget.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      add(files);
    }
  });
  for (const t of dropTargets) {
    t.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
      e.preventDefault();
      t.classList.add('drop-target');
    });
    t.addEventListener('dragleave', () => t.classList.remove('drop-target'));
    t.addEventListener('drop', (e) => {
      t.classList.remove('drop-target');
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      add([...e.dataTransfer.files]);
    });
  }
  return {
    names: () => items.filter((i) => i.name).map((i) => i.name),
    busy: () => items.some((i) => i.uploading),
    clear: () => {
      items.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
      items.length = 0;
      render();
    },
  };
}

const mainAttach = makeAttacher({
  scope: 'project',
  tray: $('#mainTray'),
  button: $('#mainAttach'),
  fileInput: $('#mainFile'),
  pasteTarget: $('#input'),
  dropTargets: [$('#composer'), $('#messages')],
});
const helperAttach = makeAttacher({
  scope: 'helper',
  tray: $('#helperTray'),
  button: $('#helperAttach'),
  fileInput: $('#helperFile'),
  pasteTarget: $('#helperInput'),
  dropTargets: [$('#helperForm'), $('#helperMessages')],
});

// ── Review settings (Tasks tab) ────────────────────────────────────────

$('#reviewMode').onchange = (e) => send({ type: 'set_review_mode', mode: e.target.value });
$('#testSave').onclick = () => send({ type: 'set_test_command', command: $('#testCmd').value });
$('#desktopSave').onclick = () => send({ type: 'set_desktop_test_command', command: $('#desktopCmd').value });
$('#desktopCmd').onkeydown = (e) => {
  if (e.key === 'Enter') $('#desktopSave').click();
};
$('#testCmd').onkeydown = (e) => {
  if (e.key === 'Enter') $('#testSave').click();
};
$('#taskList').onclick = async (e) => {
  const { reviewAction, task } = e.target.dataset;
  // A click on the row (not a button or menu) opens or closes its details.
  const row = e.target.closest('tr.task-row');
  if (!reviewAction && row && !e.target.closest('button, select, a')) {
    const id = row.dataset.taskRow;
    openTasks.has(id) ? openTasks.delete(id) : openTasks.add(id);
    renderTasks();
    return;
  }
  if (!reviewAction) return;
  let note = '';
  if (reviewAction === 'send_back') {
    note = (await askText(`What should be changed in ${task}?`, '', true)) ?? '';
    if (!note.trim()) return;
  }
  send({ type: 'review_action', taskId: task, action: reviewAction, note });
};
$('#taskList').onchange = (e) => {
  const owned = e.target.dataset.setOwner;
  if (owned && e.target.value) {
    send({ type: 'review_action', taskId: owned, action: 'set_owner', note: e.target.value });
    e.target.value = '';
    return;
  }
  const task = e.target.dataset.reviewBy;
  if (task && e.target.value) send({ type: 'review_action', taskId: task, action: 'reassign', note: e.target.value });
};

// "out until" labels and Try now depend on the clock, so refresh them now and then.
setInterval(() => {
  if (state.agents) renderAgents();
  renderHelperPause();
}, 30_000);

connect();

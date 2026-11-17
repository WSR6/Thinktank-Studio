import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkScope, findOverlaps, matches, overlapId, type OwnedTask } from '../server/ownership.js';

const task = (id: string, owner: string | undefined, files?: unknown, extra: Partial<OwnedTask> = {}): OwnedTask => ({ id, owner, files, ...extra });
/** Overlaps as "task:pattern ~ task:pattern" strings, for short assertions. */
const pairs = (tasks: OwnedTask[]) => findOverlaps(tasks).map((o) => `${o.a.task}:${o.a.pattern} ~ ${o.b.task}:${o.b.pattern}`);

// ── matches ─────────────────────────────────────────────────────────────

test('matches: a plain path covers the file and everything under it', () => {
  assert.equal(matches('README.md', 'README.md'), true);
  assert.equal(matches('src/api/routes.ts', 'src/api'), true);
  assert.equal(matches('src/api', 'src/api'), true);
  // A folder name is not a prefix of other names.
  assert.equal(matches('src/apix/routes.ts', 'src/api'), false);
  assert.equal(matches('README.md.bak', 'README.md'), false);
  assert.equal(matches('docs/README.md', 'README.md'), false);
});

test('matches: * stays inside one folder, ** crosses folders', () => {
  assert.equal(matches('src/a.ts', 'src/*.ts'), true);
  assert.equal(matches('src/deep/a.ts', 'src/*.ts'), false);
  assert.equal(matches('src/deep/a.ts', 'src/**/*.ts'), true);
  // **/ also matches zero folders.
  assert.equal(matches('src/a.ts', 'src/**/*.ts'), true);
  assert.equal(matches('a.ts', '**/*.ts'), true);
  assert.equal(matches('src/api/v1/x.ts', 'src/api/**'), true);
  assert.equal(matches('src/a.js', 'src/**/*.ts'), false);
});

test('matches: ? is exactly one character, never a slash', () => {
  assert.equal(matches('src/a.ts', 'src/?.ts'), true);
  assert.equal(matches('src/ab.ts', 'src/?.ts'), false);
  assert.equal(matches('src/a/ts', 'src/a?ts'), false);
});

test('matches: regex characters in a path are literal', () => {
  assert.equal(matches('src/a+b (1).ts', 'src/a+b (1).ts'), true);
  assert.equal(matches('src/aab (1).ts', 'src/a+b (1).ts'), false);
  assert.equal(matches('srcXapi', 'src.api'), false);
  assert.equal(matches('app/[id]/page.tsx', 'app/[id]/page.tsx'), true);
  assert.equal(matches('app/i/page.tsx', 'app/[id]/page.tsx'), false);
});

test('matches: backslashes, ./ and trailing slashes are normalized on both sides', () => {
  assert.equal(matches('src\\api\\routes.ts', 'src/api/**'), true);
  assert.equal(matches('src/api/routes.ts', '.\\src\\api\\'), true);
  assert.equal(matches('./src/api/routes.ts', 'src/api/'), true);
  assert.equal(matches('src/api/routes.ts', '  src/api  '), true);
});

// ── findOverlaps ────────────────────────────────────────────────────────

test('findOverlaps: two owners claiming the same area', () => {
  const found = findOverlaps([task('t1', 'a', ['src/api/**']), task('t2', 'b', ['src/api/routes.ts'])]);
  assert.deepEqual(found, [
    { a: { task: 't1', owner: 'a', pattern: 'src/api/**' }, b: { task: 't2', owner: 'b', pattern: 'src/api/routes.ts' } },
  ]);
});

test('findOverlaps: a folder claim meets a claim on something inside it', () => {
  assert.deepEqual(pairs([task('t1', 'a', ['src']), task('t2', 'b', ['src/ui/app.css'])]), ['t1:src ~ t2:src/ui/app.css']);
  assert.deepEqual(pairs([task('t1', 'a', ['src/ui/app.css']), task('t2', 'b', ['src/'])]), ['t1:src/ui/app.css ~ t2:src']);
  assert.deepEqual(pairs([task('t1', 'a', ['**']), task('t2', 'b', ['docs/x.md'])]), ['t1:** ~ t2:docs/x.md']);
});

test('findOverlaps: separate areas do not overlap', () => {
  assert.deepEqual(pairs([task('t1', 'a', ['src/api/**']), task('t2', 'b', ['src/ui/**'])]), []);
  assert.deepEqual(pairs([task('t1', 'a', ['src/api']), task('t2', 'b', ['src/apix'])]), []);
  assert.deepEqual(pairs([task('t1', 'a', ['README.md']), task('t2', 'b', ['docs/README.md'])]), []);
});

test('findOverlaps: wildcard names that cannot be the same file', () => {
  assert.deepEqual(pairs([task('t1', 'a', ['src/*.ts']), task('t2', 'b', ['src/*.js'])]), []);
  assert.deepEqual(pairs([task('t1', 'a', ['src/test-*']), task('t2', 'b', ['src/lib-*'])]), []);
  // *.ts means files in that folder, not a folder called x.ts with things under it.
  assert.deepEqual(pairs([task('t1', 'a', ['src/*.ts']), task('t2', 'b', ['src/deep/a.ts'])]), []);
});

test('findOverlaps: wildcard names that could be the same file', () => {
  assert.deepEqual(pairs([task('t1', 'a', ['src/*.ts']), task('t2', 'b', ['src/a*'])]), ['t1:src/*.ts ~ t2:src/a*']);
  assert.deepEqual(pairs([task('t1', 'a', ['src/*.ts']), task('t2', 'b', ['src/a.ts'])]), ['t1:src/*.ts ~ t2:src/a.ts']);
  assert.deepEqual(pairs([task('t1', 'a', ['**/*.md']), task('t2', 'b', ['docs/guide/intro.md'])]), ['t1:**/*.md ~ t2:docs/guide/intro.md']);
  assert.deepEqual(pairs([task('t1', 'a', ['src/**/index.ts']), task('t2', 'b', ['src/ui/**'])]), ['t1:src/**/index.ts ~ t2:src/ui/**']);
});

test('findOverlaps: the same owner never overlaps with itself', () => {
  assert.deepEqual(pairs([task('t1', 'a', ['src/**']), task('t2', 'a', ['src/api/**'])]), []);
});

test('findOverlaps: finished and unowned tasks are left out', () => {
  assert.deepEqual(pairs([task('t1', 'a', ['src/**'], { status: 'done' }), task('t2', 'b', ['src/**'])]), []);
  assert.deepEqual(pairs([task('t1', undefined, ['src/**']), task('t2', 'b', ['src/**'])]), []);
  assert.deepEqual(pairs([task('t1', '', ['src/**']), task('t2', 'b', ['src/**'])]), []);
  // Blocked or in progress still counts: it can run alongside.
  assert.deepEqual(pairs([task('t1', 'a', ['src/**'], { status: 'blocked' }), task('t2', 'b', ['src/**'], { status: 'doing' })]), ['t1:src/** ~ t2:src/**']);
});

test('findOverlaps: tasks that run one after the other do not overlap', () => {
  const direct = [task('t1', 'a', ['src/**']), task('t2', 'b', ['src/**'], { after: ['t1'] })];
  assert.deepEqual(pairs(direct), []);
  // Through a task in between, in either listing order.
  const chain = [task('t3', 'b', ['src/**'], { after: ['t2'] }), task('t2', 'c', ['docs/**'], { after: ['t1'] }), task('t1', 'a', ['src/**'])];
  assert.deepEqual(pairs(chain), []);
  // Through a finished task in between.
  const viaDone = [task('t1', 'a', ['src/**']), task('t2', 'c', ['docs/**'], { after: ['t1'], status: 'done' }), task('t3', 'b', ['src/**'], { after: ['t2'] })];
  assert.deepEqual(pairs(viaDone), []);
});

test('findOverlaps: siblings that both come after the same task still overlap', () => {
  const tasks = [task('t1', 'a', ['base/**']), task('t2', 'b', ['src/**'], { after: ['t1'] }), task('t3', 'c', ['src/api/**'], { after: ['t1'] })];
  assert.deepEqual(pairs(tasks), ['t2:src/** ~ t3:src/api/**']);
});

test('findOverlaps: odd "after" values are tolerated', () => {
  // A cycle must not hang; both tasks count as coming after each other.
  const cycle = [task('t1', 'a', ['src/**'], { after: ['t2'] }), task('t2', 'b', ['src/**'], { after: ['t1'] })];
  assert.deepEqual(pairs(cycle), []);
  const self = [task('t1', 'a', ['src/**'], { after: ['t1'] }), task('t2', 'b', ['src/**'])];
  assert.deepEqual(pairs(self), ['t1:src/** ~ t2:src/**']);
  // Not a list, unknown ids, non-strings: ignored.
  const junk = [task('t1', 'a', ['src/**'], { after: 't2' }), task('t2', 'b', ['src/**'], { after: [7, null, 'nope'] })];
  assert.deepEqual(pairs(junk), ['t1:src/** ~ t2:src/**']);
});

test('findOverlaps: odd "files" values are tolerated', () => {
  assert.deepEqual(pairs([task('t1', 'a', 'src/**'), task('t2', 'b', ['src/**'])]), []);
  assert.deepEqual(pairs([task('t1', 'a', [42, '', '   ', null, 'src/**']), task('t2', 'b', ['src/x.ts'])]), ['t1:src/** ~ t2:src/x.ts']);
  assert.deepEqual(pairs([task('t1', 'a'), task('t2', 'b')]), []);
  assert.deepEqual(pairs([]), []);
});

test('findOverlaps: every overlapping pair of claims is reported, with normalized patterns', () => {
  const tasks = [task('t1', 'a', ['.\\src\\api\\', 'docs']), task('t2', 'b', ['src/api/x.ts', 'docs/a.md']), task('t3', 'c', ['docs/**'])];
  assert.deepEqual(pairs(tasks), ['t1:src/api ~ t2:src/api/x.ts', 't1:docs ~ t2:docs/a.md', 't1:docs ~ t3:docs/**', 't2:docs/a.md ~ t3:docs/**']);
});

test('overlapId is the same whichever task comes first', () => {
  const [ab] = findOverlaps([task('t1', 'a', ['src/**']), task('t2', 'b', ['src/x.ts'])]);
  const [ba] = findOverlaps([task('t2', 'b', ['src/x.ts']), task('t1', 'a', ['src/**'])]);
  assert.equal(overlapId(ab), overlapId(ba));
  assert.equal(overlapId(ab), 't1:src/** | t2:src/x.ts');
});

// ── checkScope ──────────────────────────────────────────────────────────

const team = [task('t1', 'a', ['src/api/**']), task('t2', 'b', ['src/ui/**', 'README.md'])];

test('checkScope: files inside the agent\'s own area are fine', () => {
  assert.deepEqual(checkScope('a', ['src/api/routes.ts', 'src/api/v1/users.ts'], team), { outside: [], foreign: [] });
});

test('checkScope: a file in a teammate\'s area is foreign, with the task that claims it', () => {
  assert.deepEqual(checkScope('a', ['src/api/routes.ts', 'src/ui/app.css', 'README.md'], team), {
    outside: [],
    foreign: [
      { file: 'src/ui/app.css', owner: 'b', task: 't2' },
      { file: 'README.md', owner: 'b', task: 't2' },
    ],
  });
});

test('checkScope: a file nobody claims is outside, when the agent has claimed an area', () => {
  assert.deepEqual(checkScope('a', ['docs/notes.md', 'src/api/x.ts'], team), { outside: ['docs/notes.md'], foreign: [] });
});

test('checkScope: an agent whose tasks claim nothing may edit anything unclaimed', () => {
  const tasks = [task('t1', 'a'), task('t2', 'b', ['src/ui/**'])];
  assert.deepEqual(checkScope('a', ['docs/notes.md', 'src/ui/app.css'], tasks), { outside: [], foreign: [{ file: 'src/ui/app.css', owner: 'b', task: 't2' }] });
  // No tasks at all: same.
  assert.deepEqual(checkScope('c', ['docs/notes.md'], tasks), { outside: [], foreign: [] });
});

test('checkScope: one task without files makes the agent unrestricted, but teammates\' areas stay foreign', () => {
  const tasks = [task('t1', 'a', ['src/api/**']), task('t3', 'a', []), task('t2', 'b', ['src/ui/**'])];
  assert.deepEqual(checkScope('a', ['docs/notes.md', 'src/ui/app.css'], tasks), { outside: [], foreign: [{ file: 'src/ui/app.css', owner: 'b', task: 't2' }] });
});

test('checkScope: a file both agents claim counts as the agent\'s own', () => {
  const tasks = [task('t1', 'a', ['src/**']), task('t2', 'b', ['src/ui/**'])];
  assert.deepEqual(checkScope('a', ['src/ui/app.css'], tasks), { outside: [], foreign: [] });
  assert.deepEqual(checkScope('b', ['src/api/x.ts'], tasks), { outside: [], foreign: [{ file: 'src/api/x.ts', owner: 'a', task: 't1' }] });
});

test('checkScope: finished tasks still mark an area as someone\'s', () => {
  const tasks = [task('t1', 'a', ['src/api/**']), task('t2', 'b', ['src/ui/**'], { status: 'done' })];
  assert.deepEqual(checkScope('a', ['src/ui/app.css'], tasks).foreign, [{ file: 'src/ui/app.css', owner: 'b', task: 't2' }]);
});

test('checkScope: generated lockfiles and tool output are nobody\'s area', () => {
  const tasks = [task('t1', 'a', ['src/api/**']), task('t2', 'b', ['**'])];
  const files = ['package-lock.json', 'web/pnpm-lock.yaml', 'Cargo.lock', 'coverage/lcov.info', 'pkg/test-results/out.xml', 'src/__pycache__/x.pyc', '.vitest/cache.json'];
  assert.deepEqual(checkScope('a', files, tasks), { outside: [], foreign: [] });
});

test('checkScope: hand-written dependency files and look-alike names still count', () => {
  const tasks = [task('t1', 'a', ['src/api/**']), task('t2', 'b', ['web/**'])];
  assert.deepEqual(checkScope('a', ['requirements.txt', 'package.json', 'mycoverage/x.txt', 'web/package.json'], tasks), {
    outside: ['requirements.txt', 'package.json', 'mycoverage/x.txt'],
    foreign: [{ file: 'web/package.json', owner: 'b', task: 't2' }],
  });
});

test('checkScope: tasks without an owner claim nothing', () => {
  const tasks = [task('t1', 'a', ['src/api/**']), task('t2', undefined, ['docs/**'])];
  assert.deepEqual(checkScope('a', ['docs/x.md'], tasks), { outside: ['docs/x.md'], foreign: [] });
});

test('checkScope: no files, no report', () => {
  assert.deepEqual(checkScope('a', [], team), { outside: [], foreign: [] });
});

test('checkScope: when two teammates claim the file, the first task in the list is named', () => {
  const tasks = [task('t1', 'a', ['src/api/**']), task('t2', 'b', ['docs/**']), task('t3', 'c', ['docs/guide.md'])];
  assert.deepEqual(checkScope('a', ['docs/guide.md'], tasks).foreign, [{ file: 'docs/guide.md', owner: 'b', task: 't2' }]);
  assert.deepEqual(checkScope('a', ['docs/guide.md'], [tasks[0], tasks[2], tasks[1]]).foreign, [{ file: 'docs/guide.md', owner: 'c', task: 't3' }]);
});

test('a wildcard file name: matches treats it as a possible folder, findOverlaps does not', () => {
  // Pins a known difference between the two checks (a folder named like a file, e.g. src/foo.ts/).
  assert.equal(matches('src/foo.ts/bar', 'src/*.ts'), true);
  assert.deepEqual(pairs([task('t1', 'a', ['src/*.ts']), task('t2', 'b', ['src/foo.ts/bar'])]), []);
});

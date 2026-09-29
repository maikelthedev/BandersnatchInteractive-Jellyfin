/*
 * Checks that every choice point in the interactive manifest reaches the screen
 * and that every option does what the data says it does.
 *
 * The engine is driven in a stubbed browser: for each moment it is played up to
 * the frame the UI is supposed to appear on, the rendered buttons/keypad are
 * compared with the manifest, and each option is picked in turn and compared
 * against an independent implementation of the manifest's own resolution rules
 * (segment id, then segment group + preconditions).  A fresh viewer state is
 * seeded for every option so both sides see the same state.
 *
 * usage: node test-coverage.js
 */
'use strict';
const H = require('./test-harness');
const { sandbox, bnd, video, document } = H;
const STORE = sandbox.window.localStorage;

/* the manifest is the source of truth; these are the options it gives no
   destination at all - they only set tracking state, exactly as on Netflix */
const COSMETIC = [
  '2B[0]', '2Bp1[0]', '2Bp2[0]', '2Bt1[0]', '2Bt2[0]',   // the flashback "NO"
  '7D[0]', '7D[1]'                                        // YES / FUCK YEAH
];

const SEGS = bnd.data.segmentMap.segments;
const MOMENTS = bnd.data.moments;
const PRE = bnd.data.interactive.preconditions;
const GROUPS = bnd.data.segmentGroups;

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };

/* ------------------------------------------------- independent preconditions */
function seed(state) {
  const keys = [];
  for (let i = 0; i < STORE.length; i++) { const k = STORE.key(i); if (k && k.indexOf('bnd.') === 0) keys.push(k); }
  keys.forEach((k) => STORE.removeItem(k));
  STORE.setItem('bnd.initialized', 'true');
  for (const [k, v] of Object.entries(state || {})) STORE.setItem('bnd.persistentState_' + k, JSON.stringify(v));
}
const stored = (k) => { const v = STORE.getItem('bnd.persistentState_' + k);
  if (v === null) return undefined;
  try { return JSON.parse(v); } catch (e) { return v; } };
function ev(c) {
  if (c === undefined || c === null) return true;
  if (typeof c === 'boolean' || typeof c === 'number') return c;
  if (typeof c === 'string') return ev(PRE[c]);
  if (!Array.isArray(c) || !c.length) return true;
  const [op, ...a] = c;
  if (op === 'persistentState') return stored(a[0]);
  if (op === 'not') return !ev(a[0]);
  if (op === 'and') return a.every(ev);
  if (op === 'or') return a.some(ev);
  if (op === 'eql') return ev(a[0]) === ev(a[1]);
  fail('unsupported precondition operator ' + op);
  return true;
}
function resolveGroup(g, seen) {
  seen = seen || new Set();
  if (seen.has(g)) { return null; }
  seen.add(g);
  for (const v of GROUPS[g] || []) {
    if (typeof v === 'string') { if (!ev(v)) continue; return v; }
    if (v.precondition && !ev(v.precondition)) continue;
    if (v.segmentGroup) return resolveGroup(v.segmentGroup, seen);
    if (v.segment) return v.segment;
    if (!ev(v)) continue;
    return v;
  }
  return null;
}

/* --------------------------------------------------------- manifest sanity */
for (const [segId, list] of Object.entries(MOMENTS)) {
  const seg = SEGS[segId];
  if (!seg) { fail(`moments for unknown segment ${segId}`); continue; }
  for (const m of list) {
    if (m.endMs > seg.endTimeMs) fail(`${segId}: a moment ends past its segment`);
    for (const c of m.choices || []) {
      const target = c.segmentId || (c.sg ? null : null);
      if (target && !SEGS[target]) fail(`${segId}: choice targets unknown segment ${target}`);
    }
  }
}

/* ------------------------------------------------- drive the player, option by option */
const counts = { moments: 0, options: 0, buttons: 0, keypads: 0, postPlay: 0 };
const unresolved = [];
const blanks = [];
const wrong = [];
const notShown = [];

for (const [segId, list] of Object.entries(MOMENTS)) {
  for (const m of list) {
    if (!(m.choices || []).length) { continue; }        // impressions and notifications
    counts.moments++;
    if (/PostPlay/.test(m.type)) { counts.postPlay++; }
    const phone = m.type === 'scene:cs_bs_phone';
    const at = m.uiDisplayMS != null ? m.uiDisplayMS : m.startMs;
    for (let i = 0; i < m.choices.length; i++) {
      counts.options++;
      const c = m.choices[i];
      const where = `${segId}[${i}]`;
      seed(bnd.data.interactive.stateHistory);
      try {
        bnd.playSegment(segId);
        H.setWrite(true); video.currentTime = at / 1000; H.setWrite(false);
        bnd.onTimeUpdate();
      } catch (e) {
        fail(`${where} could not be played: ${e.message}`);
        continue;
      }
      if (bnd.getSegment() !== segId) { notShown.push(`${where} landed in ${bnd.getSegment()}`); continue; }

      // resolution is read *after* the moment is on screen: showing a moment
      // may set state that the choice itself depends on
      const expected = c.segmentId || (c.sg ? resolveGroup(c.sg) : null) || null;
      if (!expected && COSMETIC.indexOf(where) === -1) { unresolved.push(`${where} "${c.text}"`); }

      if (i === 0) {
        const choicesEl = document.getElementById('choices');
        const keypadEl = document.getElementById('keypad');
        if (phone) {
          if (keypadEl.className !== 'on') { fail(`${where} the keypad did not appear`); }
          if (choicesEl.children.length) { fail(`${where} buttons appeared for a keypad moment`); }
          counts.keypads++;
        } else {
          counts.buttons += choicesEl.children.length;
          if (choicesEl.children.length !== m.choices.length) {
            fail(`${where} rendered ${choicesEl.children.length} of ${m.choices.length} options`);
          }
          for (const opt of m.choices) {
            if (!opt.image && !String(opt.text || '').trim()) { blanks.push(`${where} id=${opt.id}`); }
          }
        }
      }

      // the keypad's five digits end in choose(0) for the real code and
      // choose(1) otherwise, so the decision is the same one
      let got = null;
      try {
        bnd.choose(i);
        const raw = STORE.getItem('bnd.choices');
        const hist = raw ? JSON.parse(raw) : [];
        got = hist.length ? hist[hist.length - 1].target : null;
      } catch (e) {
        fail(`${where} choosing failed: ${e.message}`);
        continue;
      }
      if (got !== expected) { wrong.push(`${where} "${c.text}" -> ${JSON.stringify(got)} != ${JSON.stringify(expected)}`); }
    }
  }
}

/* ---------------------------------------------------------------- report */
console.log('choice points: ' + counts.moments + ' (' + counts.postPlay + ' post-play recap, ' +
  (counts.moments - counts.postPlay) + ' in the story), options: ' + counts.options);
console.log('buttons rendered: ' + counts.buttons + ', keypads shown: ' + counts.keypads);
if (counts.moments !== 174) { fail(`expected 174 choice points, found ${counts.moments}`); }
if (counts.options !== 339) { fail(`expected 339 options, found ${counts.options}`); }
if (counts.postPlay !== 22) { fail(`expected 22 post-play moments, found ${counts.postPlay}`); }
if (notShown.length) { fail('moments never shown: ' + notShown.join(' ; ')); }
if (blanks.length) { fail('options with an empty label: ' + blanks.join(' ')); }
if (unresolved.length) { fail('options with an unexpected missing target: ' + unresolved.join(' ; ')); }
if (wrong.length) { fail('options that branched somewhere else: ' + wrong.slice(0, 10).join(' ; ')); }

console.log('options with no destination in the data (cosmetic only): ' + COSMETIC.length);
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

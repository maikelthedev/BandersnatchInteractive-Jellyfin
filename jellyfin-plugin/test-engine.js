/*
 * Offline check of the Bandersnatch engine: runs Web/interactive-player.js in a
 * stubbed browser and walks the story graph, verifying every automatic segment
 * transition is a legal successor of the segment we came from.
 *
 * usage: node test-engine.js
 */
'use strict';
const path = require('path');
const H = require('./test-harness');
const { sandbox, bnd, video, document, docListeners, textTracks } = H;
const setWrite = H.setWrite;

function seeksCount() { return H.seeks(); }

const SEG = bnd.data.segmentMap.segments;
const interactive = bnd.data.interactive;
const groups = bnd.data.segmentGroups;

// independent implementation of "where does this segment go by default?"
function expectedDefaultNext(id) {
  const s = SEG[id];
  const resolve = (g) => {
    for (const v of groups[g] || []) {
      if (v.precondition) continue;      // may or may not apply; we only check the legal set
      if (v.segmentGroup) return resolve(v.segmentGroup);
      if (v.segment) return v.segment;
      return v;
    }
    return null;
  };
  const legal = new Set(Object.keys(s.next || {}));
  if (s.defaultNext) legal.add(s.defaultNext);
  if (groups[id]) { const r = resolve(id); if (r) legal.add(r); }
  return { legal, fallback: s.defaultNext || resolve(id) || Object.keys(s.next || {})[0] };
}

/* --------------------------------------------------------------- the walk */
let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.log('  FAIL ' + msg); }
}

const itemId = 'item1';
sandbox.BandersnatchPlayer(itemId);
bnd.playSegment('1A');

const seq = [];
let ms = 0;
let steps = 0;
let lastSeg = null;
let pendingPrev = null;
let jumps = 0;

while (steps++ < 400000) {
  // adopt any seek the engine performed on the previous tick
  const enginePos = video.currentTime * 1000;
  if (Math.abs(enginePos - ms) > 1) { jumps++; ms = enginePos; }
  ms += 250;
  setWrite(true);
  video.currentTime = ms / 1000;
  setWrite(false);
  bnd.onTimeUpdate();
  const cur = bnd.getSegment();
  if (cur !== lastSeg) {
    if (lastSeg && pendingPrev && cur !== pendingPrev) {
      const { legal } = expectedDefaultNext(lastSeg);
      check(legal.has(cur),
        `illegal transition ${lastSeg} -> ${cur} (legal: ${[...legal].join(',')})`);
    }
    seq.push({ from: lastSeg, to: cur, at: ms });
    pendingPrev = cur;
    lastSeg = cur;
  }
  ms += 250;
  if (ms > 18734240) break;
}

console.log('segments visited (linear default path):', seq.length, '| engine seeks:', seeksCount());
const boundaries = seq.filter((s) => s.from).map((s) => {
  const p = SEG[s.from];
  return { from: s.from, to: s.to, at: s.at, contiguous: p.endTimeMs === SEG[s.to].startTimeMs };
});
console.log('transitions:', boundaries.length,
  '| non-contiguous (= real branch seek):', boundaries.filter((b) => !b.contiguous).length);
console.log(boundaries.filter((b) => !b.contiguous).map((b) => `${b.from}->${b.to}`).join(' '));
console.log('path:', seq.map((s) => s.to).join(' -> ').slice(0, 500));

/* --------------------------------------------------- explicit choice check */
function reset() { sandbox.__bnd.playSegment('1A'); video.currentTime = 0; bnd.onTimeUpdate(); }

function advanceUntilSegmentChange(startMs, limit) {
  let ms = startMs;
  const was = bnd.getSegment();
  for (let i = 0; i < limit; i++) {
    ms += 100;
    setWrite(true); video.currentTime = ms / 1000; setWrite(false);
    bnd.onTimeUpdate();
    if (bnd.getSegment() !== was) { return bnd.getSegment(); }
  }
  return bnd.getSegment();
}

// a moment whose choice is deferred to the end of the segment (the normal case)
const deferred = (() => {
  for (const segId of Object.keys(bnd.data.moments)) {
    for (const m of bnd.data.moments[segId]) {
      if (m.choices && m.config && m.config.disableImmediateSceneTransition &&
          m.choices.some((c) => c.segmentId)) { return { segId, m }; }
    }
  }
  return null;
})();

if (deferred) {
  reset();
  const { segId, m } = deferred;
  bnd.seek(m.startMs); bnd.onTimeUpdate();
  const before = bnd.getSegment();
  const opt = m.choices.find((c) => c.segmentId);
  bnd.choose(m.choices.indexOf(opt));
  check(bnd.getSegment() === before, 'a deferred choice must not cut away immediately');
  const after = advanceUntilSegmentChange(m.startMs, 20000);
  console.log(`deferred choice in ${segId}: chose ${opt.id} -> landed on ${after} (expected ${opt.segmentId})`);
  check(after === opt.segmentId, `deferred choice landed on ${after}, expected ${opt.segmentId}`);
}

// a moment that cuts away as soon as you pick
const immediate = (() => {
  for (const segId of Object.keys(bnd.data.moments)) {
    for (const m of bnd.data.moments[segId]) {
      if (m.choices && m.choices.some((c) => c.segmentId) &&
          !(m.config && m.config.disableImmediateSceneTransition)) { return { segId, m }; }
    }
  }
  return null;
})();

if (immediate) {
  reset();
  const { segId, m } = immediate;
  bnd.seek(m.startMs); bnd.onTimeUpdate();
  const opt = m.choices.find((c) => c.segmentId);
  bnd.choose(m.choices.indexOf(opt));
  const after = bnd.getSegment();
  console.log(`immediate choice in ${segId}: chose ${opt.id} -> ${after} (expected ${opt.segmentId})`);
  check(after === opt.segmentId, `immediate choice landed on ${after}, expected ${opt.segmentId}`);
} else {
  console.log('no immediate-cut choice in the data');
}

// taking no choice at all must follow defaultNext
reset();
const noChoiceTarget = advanceUntilSegmentChange(0, 200000);
console.log('no choice at the first decision -> ' + noChoiceTarget + ' (expected 1E)');
check(noChoiceTarget === '1E', `default path after 1A is ${noChoiceTarget}, expected 1E`);

/* ---------------------------------------------------- subtitle cycling */
check(textTracks.length === 2, `expected 2 subtitle tracks, got ${textTracks.length}`);
check(textTracks.map((t) => t.language).join(',') === 'es,en',
  `subtitle order is ${textTracks.map((t) => t.language).join(',')}`);
check(textTracks.map((t) => t.label).join(',') === 'Español,English',
  `subtitle labels are ${textTracks.map((t) => t.label).join(',')}`);

function pressS() {
  (docListeners.keydown || []).forEach((f) => f({ code: 'KeyS', preventDefault() {}, stopPropagation() {} }));
}
function showing() {
  const s = textTracks.filter((t) => t.mode === 'showing').map((t) => t.language);
  return s.length ? s[0] : null;
}
function choiceText(segmentId, choiceId) {
  const list = bnd.data.moments[segmentId] || [];
  for (const m of list) {
    for (const c of m.choices || []) {
      if (c.id === choiceId) { return c.text; }
    }
  }
  return null;
}
function caption() { return document.getElementById('caption').textContent; }

// sit inside the cereal choice so a caption is on screen
bnd.seek(136500);
bnd.onTimeUpdate();
check(caption() === 'Which Cereal?', `caption starts as "${caption()}"`);
check(choiceText('2G', '1S') === 'THE BERMUDA TRIANGLE', 'labels start in English');

const subtitleSteps = [];
pressS();                                     // off -> es
subtitleSteps.push(showing());
check(choiceText('2G', '1S') === 'EL TRIÁNGULO DE LAS BERMUDAS',
  `spanish labels expected, got ${choiceText('2G', '1S')}`);
check(caption() === '¿Qué cereal?', `spanish caption expected, got "${caption()}"`);
check(choiceText('1A', '1E') === 'SUGAR PUFFS', 'brand names are left as they are');

pressS();                                     // es -> en
subtitleSteps.push(showing());
check(choiceText('2G', '1S') === 'THE BERMUDA TRIANGLE', 'labels return to English');
check(caption() === 'Which Cereal?', 'caption returns to English');

pressS();                                     // en -> off
subtitleSteps.push(showing());
check(choiceText('2G', '1S') === 'THE BERMUDA TRIANGLE', 'hiding subtitles keeps the labels');

pressS();                                     // off -> es again
subtitleSteps.push(showing());
console.log('S cycles through: ' + subtitleSteps.map((x) => x || 'off').join(' -> '));
check(subtitleSteps[0] === 'es', 'first S should select Español');
check(subtitleSteps[1] === 'en', 'second S should select English');
check(subtitleSteps[2] === null, 'third S should turn subtitles off');
check(subtitleSteps[3] === 'es', 'fourth S should come back to Español');
check(textTracks.filter((t) => t.mode === 'showing').length <= 1, 'only one track shows at a time');

/* ------------------------------------------------------- boundary sanity */
check(bnd.getSegmentId(0) === '1A', 't=0 should be segment 1A');
check(bnd.getSegmentId(18734239) !== null, 'the very end should map to a segment');
const starts = Object.values(SEG).map((s) => s.startTimeMs);
check(new Set(starts).size === starts.length, 'segment start times must be unique');
for (const [id, s] of Object.entries(SEG)) {
  check(bnd.getSegmentId(s.startTimeMs) === id, `start of ${id} maps to ${bnd.getSegmentId(s.startTimeMs)}`);
  check(bnd.getSegmentMs(id) === s.startTimeMs, `getSegmentMs(${id})`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

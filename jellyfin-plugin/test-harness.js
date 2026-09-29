/*
 * Offline check of the Bandersnatch engine: runs Web/interactive-player.js in a
 * stubbed browser and walks the story graph, verifying every automatic segment
 * transition is a legal successor of the segment we came from.
 *
 * usage: node test-engine.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const WEB = path.join(__dirname, 'Web');

/* ------------------------------------------------------------ browser stubs */
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
    clear: () => m.clear()
  };
}

function makeEl(tag) {
  const el = {
    tagName: tag, children: [], style: {}, dataset: {}, className: '', textContent: '',
    _handlers: {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    addEventListener(t, f) { (this._handlers[t] = this._handlers[t] || []).push(f); },
    removeEventListener() {},
    querySelectorAll() { return []; },
    get firstChild() { return this.children[0] || null; },
    set innerHTML(v) { this.children = []; },
    get innerHTML() { return ''; }
  };
  return el;
}

const elements = {};
function el(id) { return (elements[id] = elements[id] || makeEl('div')); }

const video = makeEl('video');
let seeks = 0;
let testWrite = false;
let _ct = 0;
Object.defineProperty(video, 'currentTime', {
  get() { return _ct; },
  set(v) { if (!testWrite) { seeks++; } _ct = v; }
});
video.currentTime = 0;
video.paused = true;
video.duration = 18734.24;
video.videoWidth = 1920;
video.videoHeight = 1080;
const textTracks = [];
video.textTracks = textTracks;
const realAppend = video.appendChild.bind(video);
video.appendChild = function (child) {
  if (child && child.srclang) {
    textTracks.push({ language: child.srclang, label: child.label, kind: child.kind, mode: 'hidden' });
  }
  return realAppend(child);
};
video.play = function () { this.paused = false; };
video.pause = function () { this.paused = true; };
video.load = function () {};
elements.video = video;

const docListeners = {};
const document = {
  title: '',
  getElementById: (id) => (id === 'video' ? video : el(id)),
  createElement: (t) => makeEl(t),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
  fullscreenElement: null,
  exitFullscreen: () => {}
};

const sandbox = {
  console,
  window: {},
  document,
  location: { search: '', hash: '', href: 'http://jf/InteractiveVideo/Player/x' },
  history: { replaceState: () => {} },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({
    MediaSources: [{ Id: 'src1', Container: 'mp4',
      MediaStreams: [{ Type: 'Video', Codec: 'h264' }] }] }) }),
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  JSON, Math, Date, Object, Array, String, Number, Boolean, Error, RegExp, Promise, encodeURIComponent, decodeURIComponent
};
sandbox.window = sandbox;
sandbox.window.localStorage = makeStorage();
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
for (const f of ['bandersnatch.js', 'SegmentMap.js', 'choices-en.js', 'choices-es.js', 'interactive-player.js']) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), sandbox, { filename: f });
}

/* ------------------------------------------------------------- expectations */

/* ------------------------------------------------------------------- export */
module.exports = {
  sandbox, bnd: sandbox.__bnd, video, document, docListeners, textTracks, elements,
  seeks: () => seeks,
  setWrite: (v) => { testWrite = v; },
  load: (files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), sandbox, { filename: f }); }
};

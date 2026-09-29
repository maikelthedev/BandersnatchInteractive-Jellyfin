/*!
 * Bandersnatch interactive engine for Jellyfin.
 *
 * The branching logic (segment map, moments, preconditions, breadcrumbs,
 * segment groups, state history) is a port of the original public-domain
 * BandersnatchInteractive player (https://github.com/joric/bandersnatch),
 * adapted to play the video that Jellyfin already has in its library.
 *
 * Public domain / Unlicense, same as the original.
 */
(function () {
  'use strict';

  var DEBUG = /[?&]debug=1/.test(location.search);
  var VIDEO_ID = '80988062';           // Netflix id of the interactive manifest
  var SUBTITLE_URL = '/InteractiveVideo/Subtitles/en';
  var RESUME = true;                   // remember where we were across sessions

  /* ------------------------------------------------------------------ data */

  var interactive = bandersnatch.videos[VIDEO_ID].interactiveVideoMoments.value;
  var segmentMap = SegmentMap;
  var choicePoints = interactive.choicePointNavigatorMetadata.choicePointsMetadata.choicePoints;
  var momentsBySegment = interactive.momentsBySegment;
  var segmentGroups = interactive.segmentGroups;
  var preconditions = interactive.preconditions;

  // Sorted segment table for a fast timestamp -> segment lookup.
  var segmentIds = Object.keys(segmentMap.segments);
  var segmentOrder = segmentIds.map(function (id) {
    return { id: id, start: segmentMap.segments[id].startTimeMs, end: segmentMap.segments[id].endTimeMs };
  }).sort(function (a, b) { return a.start - b.start; });

  function translateChoiceTexts() {
    var out = JSON.parse(JSON.stringify(momentsBySegment));
    if (typeof en === 'undefined') { return out; }
    for (var segment in en) {
      var list = out[segment];
      if (!list) { continue; }
      for (var i = 0; i < list.length; i++) {
        var choices = list[i].choices;
        if (!choices) { continue; }
        for (var k = 0; k < choices.length; k++) {
          var c = choices[k];
          if (c && c.id && en[segment] && (c.id in en[segment])) { c.text = en[segment][c.id]; }
        }
      }
    }
    return out;
  }
  var moments = translateChoiceTexts();

  /* --------------------------------------------------------------- storage */

  var ls = window.localStorage;
  var KEY = 'bnd.';
  function get(k, fallback) {
    var v = ls.getItem(KEY + k);
    if (v === null) { return fallback; }
    try { return JSON.parse(v); } catch (e) { return v; }
  }
  function set(k, v) { try { ls.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function clearState() {
    var keys = [];
    for (var i = 0; i < ls.length; i++) {
      var k = ls.key(i);
      if (k && k.indexOf(KEY) === 0) { keys.push(k); }
    }
    keys.forEach(function (k) { ls.removeItem(k); });
  }
  if (!get('initialized')) {
    for (var sv in interactive.stateHistory) {
      set('persistentState_' + sv, interactive.stateHistory[sv]);
    }
    set('initialized', true);
  }

  /* ---------------------------------------------------------- preconditions */

  function preconditionToJS(cond) {
    if (cond === true) { return 'true'; }
    if (cond === false) { return 'false'; }
    if (typeof cond === 'string') { return JSON.stringify(cond); }
    if (typeof cond === 'number') { return String(cond); }
    if (!cond || !cond.length) { return 'true'; }
    switch (cond[0]) {
      case 'persistentState': return 'get("persistentState_' + cond[1] + '")';
      case 'not': return '!(' + preconditionToJS(cond[1]) + ')';
      case 'and': return '(' + cond.slice(1).map(preconditionToJS).join(' && ') + ')';
      case 'or': return '(' + cond.slice(1).map(preconditionToJS).join(' || ') + ')';
      case 'eql':
        if (cond.length === 3) { return '(' + cond.slice(1).map(preconditionToJS).join(' === ') + ')'; }
        break;
    }
    log('unsupported precondition', cond);
    return 'true';
  }

  function evalPrecondition(precondition) {
    if (precondition === undefined || precondition === null) { return true; }
    try {
      return !!eval(preconditionToJS(precondition)); // eslint-disable-line no-eval
    } catch (e) {
      log('precondition failed to evaluate', precondition, e);
      return true;
    }
  }
  function checkPrecondition(id) { return evalPrecondition(preconditions[id]); }

  function resolveSegmentGroup(group) {
    var list = segmentGroups[group] || [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (v.precondition && !checkPrecondition(v.precondition)) { continue; }
      if (v.segmentGroup) { return resolveSegmentGroup(v.segmentGroup); }
      if (v.segment) { return v.segment; }
      if (!checkPrecondition(v)) { continue; }
      return v;
    }
    return null;
  }

  /* ------------------------------------------------------------ engine core */

  function getSegmentId(ms) {
    var lo = 0, hi = segmentOrder.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var s = segmentOrder[mid];
      if (ms < s.start) { hi = mid - 1; }
      else if (s.end && ms >= s.end) { lo = mid + 1; }
      else { return s.id; }
    }
    return null;
  }
  function getSegmentMs(id) { return segmentMap.segments[id].startTimeMs; }

  function getMoments(segmentId, ms) {
    var result = {};
    var list = moments[segmentId] || [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (ms >= m.startMs && ms < m.endMs && evalPrecondition(m.precondition)) {
        result[segmentId + '/' + i] = m;
      }
    }
    return result;
  }

  function applyImpression(impressionData) {
    if (!impressionData || impressionData.type !== 'userState') { return; }
    var data = impressionData.data && impressionData.data.persistent;
    if (!data) { return; }
    for (var variable in data) {
      set('persistentState_' + variable, data[variable]);
      log('persistentState', variable, '=', data[variable]);
    }
  }

  /* -------------------------------------------------------------------- dom */

  var video = document.getElementById('video');
  var choicesEl = document.getElementById('choices');
  var captionEl = document.getElementById('caption');
  var barEl = document.getElementById('bar');
  var keypadEl = document.getElementById('keypad');
  var slotsEl = document.getElementById('slots');
  var startEl = document.getElementById('start');
  var msgEl = document.getElementById('msg');
  var toastEl = document.getElementById('toast');
  var hudSegEl = document.getElementById('hud-seg');
  var hudSpeedEl = document.getElementById('hud-speed');
  var hudEl = document.getElementById('hud');

  function log() {
    if (!DEBUG) { return; }
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[bandersnatch]');
    console.log.apply(console, args);
  }
  function showMessage(text) { msgEl.textContent = text; msgEl.className = 'on'; }
  var toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.className = 'on';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ''; }, 1200);
  }

  /* ------------------------------------------------------- jellyfin streaming */

  function getToken() {
    try {
      var raw = ls.getItem('jellyfin_credentials');
      if (raw) {
        var creds = JSON.parse(raw);
        var servers = creds.Servers || [];
        var best = null;
        for (var i = 0; i < servers.length; i++) {
          var s = servers[i];
          if (!s.AccessToken) { continue; }
          if (!best) { best = s; }
          var addr = (s.ManualAddress || s.Address || '');
          if (addr && location.href.indexOf(addr.replace(/\/$/, '')) === 0) { best = s; break; }
        }
        if (best) { return best.AccessToken; }
      }
    } catch (e) { /* fall through */ }
    var m = location.search.match(/[?&]api_key=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  var token = getToken();

  function api(path) {
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    var url = path + (token ? sep + 'api_key=' + encodeURIComponent(token) : '');
    return fetch(url, { headers: token ? { Authorization: 'MediaBrowser Token="' + token + '"' } : {} })
      .then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status + ' for ' + path); } return r.json(); });
  }

  // Pick the rendition the browser can actually play: h264/mp4 first, then
  // any h264, then anything (the caller may then rely on the browser).
  function rankSource(src) {
    var v = (src.MediaStreams || []).filter(function (s) { return s.Type === 'Video'; })[0] || {};
    var codec = (v.Codec || '').toLowerCase();
    var container = (src.Container || '').toLowerCase();
    var score = 0;
    if (codec === 'h264') { score += 100; }
    else if (codec === 'vp9' || codec === 'vp8' || codec === 'av1') { score += 80; }
    else if (codec === 'hevc' || codec === 'h265') { score += 10; }
    if (container === 'mp4' || container === 'm4v' || container === 'webm') { score += 50; }
    return score;
  }

  function resolveStreamUrl(itemId) {
    return api('/Items/' + itemId + '?Fields=MediaSources')
      .then(function (item) {
        var sources = item.MediaSources || [];
        if (!sources.length) { throw new Error('item has no media sources'); }
        sources.sort(function (a, b) { return rankSource(b) - rankSource(a); });
        var chosen = sources[0];
        log('media sources', sources.map(function (s) {
          return { id: s.Id, container: s.Container, name: s.Name, score: rankSource(s) };
        }));
        var base = '/Videos/' + itemId + '/stream?static=true&mediaSourceId=' + encodeURIComponent(chosen.Id);
        if (token) { base += '&api_key=' + encodeURIComponent(token); }
        return { url: base, container: chosen.Container, source: chosen };
      })
      .catch(function (e) {
        log('PlaybackInfo lookup failed, falling back to the item id', e);
        var base = '/Videos/' + itemId + '/stream?static=true&mediaSourceId=' + encodeURIComponent(itemId);
        if (token) { base += '&api_key=' + encodeURIComponent(token); }
        return { url: base, container: null, source: null };
      });
  }

  /* ------------------------------------------------------------------- ui */

  var slots = [];
  function renderSlots() {
    var out = [];
    for (var i = 0; i < 5; i++) { out.push(slots[i] === undefined ? '-' : slots[i]); }
    slotsEl.textContent = out.join(' ');
  }
  function pressDigit(d) {
    if (slots.length >= 5) { return; }
    slots.push(d);
    renderSlots();
    if (slots.length === 5) {
      var code = slots.join('');
      var idx = code === '20541' ? 0 : 1;
      log('phone code', code, '-> choice', idx);
      choose(idx);
    }
  }

  function clearChoices() {
    while (choicesEl.firstChild) { choicesEl.removeChild(choicesEl.firstChild); }
    choicesEl.className = '';
    captionEl.className = '';
    keypadEl.className = '';
    barEl.style.width = '0%';
  }

  function renderChoices(moment) {
    clearChoices();
    selectedChoice = moment.defaultChoiceIndex || 0;

    if (moment.type === 'scene:cs_bs_phone') {
      slots = [];
      renderSlots();
      keypadEl.className = 'on';
    } else {
      (moment.choices || []).forEach(function (c, i) {
        var b = document.createElement('button');
        b.className = 'choice';
        if (c.image && c.image.styles && c.image.styles.backgroundImage) {
          b.style.backgroundImage = c.image.styles.backgroundImage;
          b.style.backgroundSize = 'contain';
          b.style.backgroundRepeat = 'no-repeat';
          b.style.backgroundPosition = 'center';
          b.style.minHeight = '4rem';
          b.style.minWidth = '11rem';
        } else {
          b.textContent = c.text;
        }
        b.addEventListener('click', function (e) { e.preventDefault(); choose(i); });
        b.addEventListener('mouseenter', function () { selectedChoice = i; paintSelection(); });
        choicesEl.appendChild(b);
      });
      choicesEl.className = 'on';
    }

    if (moment.id && choicePoints[moment.id] && choicePoints[moment.id].description) {
      captionEl.textContent = choicePoints[moment.id].description;
      captionEl.className = 'on';
    }
    paintSelection();
  }

  var selectedChoice = 0;
  function paintSelection() {
    var buttons = choicesEl.querySelectorAll('.choice');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].className = 'choice' + (i === selectedChoice ? ' sel' : '');
    }
  }

  /* ---------------------------------------------------------------- engine */

  var timerId = 0;
  var lastMs = 0;
  var currentSegment = null;
  var lastSegment = null;
  var prevSegment = null;
  var segmentTransition = false;
  var lastMoments = {};
  var currentMoment = null;
  var pendingTarget = null;   // branch chosen for the segment we are in
  var pendingFrom = null;
  var lastPlace = '';

  function getCurrentMs() { return Math.round(video.currentTime * 1000); }

  function seek(ms) {
    log('seek', ms);
    video.currentTime = ms / 1000;
    onTimeUpdate(true);
  }

  function playSegment(segmentId, noSeek) {
    if (!segmentId) { segmentId = segmentMap.initialSegment; }
    var oldSegment = getSegmentId(getCurrentMs());
    log('playSegment', oldSegment, '->', segmentId);
    if (!noSeek || oldSegment !== segmentId) {
      seek(getSegmentMs(segmentId));
      return true;
    }
    return false;
  }

  function playNextSegment(fromSegment) {
    var next = null;
    if (pendingTarget && pendingFrom === fromSegment) {
      next = pendingTarget;
      pendingTarget = null;
      pendingFrom = null;
    }
    if (!next && fromSegment && segmentGroups[fromSegment]) {
      next = resolveSegmentGroup(fromSegment);
    }
    if (!next && fromSegment && segmentMap.segments[fromSegment] &&
        segmentMap.segments[fromSegment].defaultNext) {
      next = segmentMap.segments[fromSegment].defaultNext;
    }
    if (!next) { return false; }

    var breadcrumb = 'breadcrumb_' + next;
    if (get(breadcrumb) === undefined) { set(breadcrumb, fromSegment); }
    segmentTransition = true;
    return playSegment(next, true);
  }

  function choose(index) {
    var moment = currentMoment;
    clearChoices();
    if (!moment) { return; }

    var x = (moment.choices || [])[index];
    var target = null;
    if (x) {
      if (x.segmentId) { target = x.segmentId; }
      else if (x.sg) { target = resolveSegmentGroup(x.sg); }
      applyImpression(x.impressionData);
    }
    pendingTarget = target;
    pendingFrom = currentSegment;

    set('choices', (get('choices', [])).concat([{
      at: getCurrentMs(), id: moment.id, index: index, segment: currentSegment, target: target
    }]));
    log('choice', index, 'from', currentSegment, '->', target,
        (moment.config && moment.config.disableImmediateSceneTransition) ? '(deferred)' : '(now)');

    // Netflix defers most branches until the end of the segment; only a few
    // cut away the moment you pick.
    if (!(moment.config && moment.config.disableImmediateSceneTransition)) {
      playNextSegment(currentSegment);
    }
  }

  function jumpForward() {
    var ms = getCurrentMs();
    var segmentId = getSegmentId(ms);
    var list = moments[segmentId] || [];
    var interactionMs = 0;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.startMs > ms && (interactionMs === 0 || m.startMs < interactionMs)) { interactionMs = m.startMs; }
    }
    segmentTransition = true;
    if (interactionMs) { seek(interactionMs); } else { playNextSegment(segmentId); }
  }

  function jumpBack() {
    var ms = getCurrentMs();
    var segmentId = getSegmentId(ms);
    var segment = segmentMap.segments[segmentId];
    var list = moments[segmentId] || [];
    var interactionMs = 0;
    var inMoment = false;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.endMs < ms && m.startMs > interactionMs) { interactionMs = m.startMs; }
      if (m.startMs !== segment.startTimeMs && m.startMs <= ms && ms < m.endMs) { inMoment = true; }
    }
    segmentTransition = true;
    if (interactionMs) {
      seek(interactionMs);
    } else if (inMoment) {
      seek(segment.startTimeMs);
    } else {
      var previous = get('breadcrumb_' + segmentId);
      if (previous !== undefined && segmentMap.segments[previous]) {
        var prev = segmentMap.segments[previous];
        var prevList = moments[previous] || [];
        var target = prev.startTimeMs;
        for (var j = 0; j < prevList.length; j++) {
          if (prevList[j].startMs > target) { target = prevList[j].startMs; }
        }
        seek(target);
      } else {
        seek(0);
      }
    }
  }

  function momentStart(m, seeked) {
    if (m.choices) {
      currentMoment = m;
      renderChoices(m);
    }
    if (!seeked) { applyImpression(m.impressionData); }
  }
  function momentUpdate(m, ms) {
    if (!m.choices) { return; }
    var total = m.endMs - m.startMs;
    var left = Math.max(0, m.endMs - ms);
    barEl.style.width = (total > 0 ? (left * 100 / total) : 0) + '%';
  }
  function momentEnd(m, seeked) {
    if (m.choices) {
      clearChoices();
      currentMoment = null;
    }
  }

  function onTimeUpdate(forced) {
    var ms = getCurrentMs();
    var segmentId = getSegmentId(ms);
    var segment = segmentId ? segmentMap.segments[segmentId] : null;

    if (timerId) { clearTimeout(timerId); timerId = 0; }

    var elapsed = ms - lastMs;
    var seeked = forced === true || elapsed < 0 || elapsed >= 2000;
    lastMs = ms;

    var placeChanged = false;

    if (lastSegment !== segmentId) {
      log('segment', lastSegment, '->', segmentId, ms);
      prevSegment = lastSegment;
      lastSegment = segmentId;
      currentSegment = segmentId;
      if (!seeked && prevSegment) {
        if (playNextSegment(prevSegment)) { return; } // it seeked; a fresh update is on its way
      }
      placeChanged = true;
    }

    var naturalTransition = !seeked || segmentTransition;
    segmentTransition = false;

    var currentMoments = getMoments(segmentId, ms);
    var k;
    for (k in lastMoments) {
      if (!(k in currentMoments)) { momentEnd(lastMoments[k], !naturalTransition); placeChanged = true; }
    }
    for (k in lastMoments) {
      if (k in currentMoments) { momentUpdate(lastMoments[k], ms); }
    }
    for (k in currentMoments) {
      if (!(k in lastMoments)) { momentStart(currentMoments[k], !naturalTransition); placeChanged = true; }
    }
    lastMoments = currentMoments;

    if (placeChanged) {
      var place = segmentId;
      for (k in currentMoments) {
        var m = currentMoments[k];
        if (m.startMs > (segment ? segment.startTimeMs : 0)) { place = k; }
      }
      if (place !== lastPlace) {
        lastPlace = place;
        set('place', place);
        try { history.replaceState(null, '', '#' + place); } catch (e) { /* ignore */ }
      }
      updateHud();
    }

    // timeupdate fires only ~4x/s: wake up exactly on the next boundary.
    var nextEvent = segment ? segment.endTimeMs : 0;
    for (k in currentMoments) {
      if (currentMoments[k].endMs < nextEvent) { nextEvent = currentMoments[k].endMs; }
    }
    var list = moments[segmentId] || [];
    for (var i = 0; i < list.length; i++) {
      if (ms < list[i].startMs && list[i].startMs < nextEvent) { nextEvent = list[i].startMs; }
    }
    var timeLeft = nextEvent - ms;
    if (timeLeft > 0 && !video.paused) {
      timerId = setTimeout(function () { onTimeUpdate(); }, timeLeft);
    }
  }

  function updateHud() {
    hudSegEl.textContent = currentSegment ? ('CHAPTER ' + currentSegment) : '';
    if (!barShown && currentSegment) { hudEl.className = 'on'; }
  }
  var barShown = false;

  /* ---------------------------------------------------------------- controls */

  var speedSteps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  var speedIndex = 3;

  function setSpeed(index) {
    speedIndex = Math.max(0, Math.min(speedSteps.length - 1, index));
    video.playbackRate = speedSteps[speedIndex];
    hudSpeedEl.textContent = video.playbackRate + 'x';
    toast(video.playbackRate + 'x');
  }

  function toggleFullscreen() {
    var el = document.getElementById('stage');
    if (document.fullscreenElement) { document.exitFullscreen(); }
    else if (el.requestFullscreen) { el.requestFullscreen(); }
  }

  function toggleSubtitles() {
    var tracks = video.textTracks;
    if (!tracks || !tracks.length) { return; }
    var t = tracks[0];
    t.mode = t.mode === 'showing' ? 'hidden' : 'showing';
    toast('subtitles ' + (t.mode === 'showing' ? 'on' : 'off'));
  }

  function restart() { pendingTarget = null; pendingFrom = null; playSegment(segmentMap.initialSegment); video.play(); }

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) { return; }
    var choiceMode = choicesEl.className === 'on';
    var count = choicesEl.querySelectorAll('.choice').length;
    switch (e.code) {
      case 'KeyF': toggleFullscreen(); break;
      case 'KeyR': restart(); break;
      case 'KeyS': toggleSubtitles(); break;
      case 'KeyD': DEBUG = !DEBUG; toast('debug ' + (DEBUG ? 'on' : 'off')); break;
      case 'Digit0': setSpeed(3); break;
      case 'Space': if (!choiceMode) { if (video.paused) { video.play(); } else { video.pause(); } } break;
      case 'ArrowLeft':
        if (choiceMode && count) { selectedChoice = (selectedChoice - 1 + count) % count; paintSelection(); }
        else { jumpBack(); }
        break;
      case 'ArrowRight':
        if (choiceMode && count) { selectedChoice = (selectedChoice + 1) % count; paintSelection(); }
        else { jumpForward(); }
        break;
      case 'ArrowUp': setSpeed(speedIndex + 1); break;
      case 'ArrowDown': setSpeed(speedIndex - 1); break;
      case 'Enter':
        if (choiceMode) {
          if (keypadEl.className === 'on') { break; }
          choose(selectedChoice);
        }
        break;
      default:
        if (keypadEl.className === 'on' && /^Digit[0-9]$/.test(e.code)) { pressDigit(e.code.slice(5)); }
        break;
    }
    e.preventDefault();
  });

  document.querySelectorAll('.keys button').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); pressDigit(b.dataset.d); });
  });

  video.addEventListener('click', function () {
    if (choicesEl.className !== 'on') { if (video.paused) { video.play(); } else { video.pause(); } }
  });
  video.addEventListener('dblclick', toggleFullscreen);
  video.addEventListener('timeupdate', function () { onTimeUpdate(); });
  video.addEventListener('playing', function () { hudEl.className = 'on'; barShown = true; });

  /* ------------------------------------------------------------------- boot */

  function BandersnatchPlayer(itemId) {
    this.itemId = itemId;
    this.ready = false;
    var self = this;

    video.addEventListener('loadedmetadata', function () {
      self.ready = true;
      log('video loaded', video.videoWidth + 'x' + video.videoHeight, video.duration + 's');
      if (video.videoWidth === 0) {
        showMessage('This browser cannot decode the video track (HEVC?). ' +
                    'Add an H.264 rendition of the file to the library.');
        return;
      }
      var hash = location.hash ? location.hash.slice(1) : '';
      var place = hash || (RESUME ? get('place', '') : '');
      if (place) { playPlace(place); } else { playSegment(segmentMap.initialSegment); }
      video.play().catch(function () { /* the start overlay stays up */ });
    });

    video.addEventListener('error', function () {
      var err = video.error;
      showMessage('Playback error' + (err ? ' (' + err.code + '): ' + err.message : ''));
    });

    var track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = 'English';
    track.srclang = 'en';
    track.src = SUBTITLE_URL;
    video.appendChild(track);

    startEl.addEventListener('click', function () {
      startEl.className = 'hide';
      barShown = true;
      video.play();
      if (!lastSegment) { playSegment(segmentMap.initialSegment); }
    });

    resolveStreamUrl(itemId).then(function (info) {
      log('stream', info.url, info.container);
      video.src = info.url;
      video.load();
    }).catch(function (e) {
      showMessage('Could not resolve a stream for this item: ' + e.message);
    });
  }

  function playPlace(place) {
    // place is either "<segmentId>", "<segmentId>/<momentIndex>" or "t<seconds>"
    if (place.charAt(0) === 't') {
      seek(Math.round(parseFloat(place.slice(1)) * 1000));
      return;
    }
    var parts = place.split('/');
    var segmentId = parts[0];
    if (!segmentMap.segments[segmentId]) { playSegment(segmentMap.initialSegment); return; }
    if (parts.length > 1) {
      var m = (moments[segmentId] || [])[parseInt(parts[1], 10)];
      if (m) { seek(m.startMs); return; }
    }
    seek(getSegmentMs(segmentId));
  }

  window.BandersnatchPlayer = BandersnatchPlayer;
  window.__bnd = {
    getSegmentId: getSegmentId, getSegmentMs: getSegmentMs, getMoments: getMoments,
    playSegment: function (id) { segmentTransition = true; return playSegment(id); },
    playNextSegment: playNextSegment, choose: choose, seek: seek,
    onTimeUpdate: onTimeUpdate, jumpForward: jumpForward, jumpBack: jumpBack,
    getSegment: function () { return currentSegment; },
    getState: function () { return { segment: currentSegment, prev: prevSegment, ms: getCurrentMs() }; },
    reset: function () { clearState(); location.hash = ''; location.reload(); },
    data: { segmentMap: segmentMap, moments: moments, segmentGroups: segmentGroups,
            choicePoints: choicePoints, interactive: interactive }
  };
}());

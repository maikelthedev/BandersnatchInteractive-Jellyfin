/*!
 * "Play Interactive" launcher for the Jellyfin web client.
 *
 * Loaded into the web client by the JavaScript Injector plugin (see the
 * bootstrap snippet in its configuration). On the details page of an item
 * tagged "Interactive" it replaces the native Play button with one that opens
 * this plugin's player instead: /InteractiveVideo/Player/<itemId>.
 *
 * The tag is the contract: whoever writes the metadata marks an interactive
 * title with <tag>Interactive</tag>, and the button follows.
 *
 * Deliberately NOT in the header: a title that you cannot play linearly should
 * say so where you would otherwise press Play.
 */
(function () {
  'use strict';

  var TAG = 'interactive';
  var BUTTON_ID = 'interactive-video-launch';
  var PLAYER_PATH = '/InteractiveVideo/Player/';
  // The row of round buttons next to the poster, and the buttons that start
  // playback in it (Jellyfin 12 renders them as .btnPlay / .btnReplay).
  var ROW = '.mainDetailButtons';
  var NATIVE_PLAY = '.btnPlay, .btnReplay, [data-action="resume"], [data-action="play"]';
  // Fallback for when the API cannot be reached (offline, restricted user).
  var NAME_HINT = /bandersnatch/i;

  var tagCache = {};
  var state = { itemId: null, hidden: [] };

  function log() {
    if (!/interactive-launch-debug/.test(location.search)) { return; }
    console.log.apply(console, ['[interactive-launch]'].concat(Array.prototype.slice.call(arguments)));
  }

  function getToken() {
    try {
      var raw = localStorage.getItem('jellyfin_credentials');
      if (!raw) { return null; }
      var servers = (JSON.parse(raw).Servers) || [];
      for (var i = 0; i < servers.length; i++) {
        if (servers[i].AccessToken) { return servers[i].AccessToken; }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function currentItemId() {
    var m = (location.hash || '').match(/[?&]id=([^&]+)/);
    return m ? m[1] : null;
  }

  function isInteractive(id, cb) {
    if (tagCache[id] !== undefined) { return cb(tagCache[id]); }
    var token = getToken();
    var url = '/Items/' + id + '?Fields=Tags' + (token ? '&api_key=' + encodeURIComponent(token) : '');
    fetch(url, { headers: token ? { Authorization: 'MediaBrowser Token="' + token + '"' } : {} })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (item) {
        var hit = !!item && ((item.Tags || []).some(function (t) {
          return String(t).toLowerCase() === TAG;
        }) || NAME_HINT.test(item.Name || ''));
        log('item', id, item && item.Name, item && item.Tags, '->', hit);
        tagCache[id] = hit;
        cb(hit);
      })
      .catch(function (e) { log('lookup failed', e); cb(false); });
  }

  /* --------------------------------------------------------------- button */

  function makeButton(id) {
    // Same classes as the native buttons so it inherits their styling, with the
    // label the native ones do not carry.
    var b = document.createElement('button');
    b.id = BUTTON_ID;
    b.type = 'button';
    b.setAttribute('is', 'emby-button');
    b.className = 'button-flat detailButton emby-button interactive-launcher';
    b.title = 'Play Interactive — choose your own adventure';
    b.setAttribute('data-action', 'interactive');

    var content = document.createElement('div');
    content.className = 'detailButton-content';
    var icon = document.createElement('span');
    icon.className = 'material-icons detailButton-icon play_circle';
    icon.setAttribute('aria-hidden', 'true');
    var text = document.createElement('div');
    text.className = 'detailButton-text';
    text.textContent = 'Interactive';
    content.appendChild(icon);
    content.appendChild(text);
    b.appendChild(content);

    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      window.open(PLAYER_PATH + id, '_blank');
    });
    return b;
  }

  function hideNatives(row) {
    var plays = row.querySelectorAll(NATIVE_PLAY);
    for (var i = 0; i < plays.length; i++) {
      var el = plays[i];
      if (el.id === BUTTON_ID) { continue; }
      if (el.style.display === 'none') { continue; }
      el.style.display = 'none';
      state.hidden.push(el);
      log('hid native button', el.className);
    }
  }

  function restoreNatives() {
    state.hidden.forEach(function (el) {
      if (el && el.style) { el.style.removeProperty('display'); }
    });
    state.hidden = [];
  }

  function removeButton() {
    var b = document.getElementById(BUTTON_ID);
    if (b && b.parentNode) { b.parentNode.removeChild(b); }
  }

  /* Last resort only: the details page has no button row (a layout we do not
   * know). Better a visible way in than none, but it is not the normal path. */
  function floatButton(id) {
    var b = makeButton(id);
    b.style.position = 'fixed';
    b.style.right = '24px';
    b.style.bottom = '24px';
    b.style.zIndex = '2000';
    b.style.background = 'rgba(0,0,0,.75)';
    b.style.borderRadius = '8px';
    document.body.appendChild(b);
    log('floating fallback');
  }

  function place(id) {
    var row = document.querySelector(ROW);
    if (!row || row.offsetParent === null && row.getBoundingClientRect().width === 0) {
      if (document.querySelector('#itemDetailPage')) { floatButton(id); }
      return;
    }
    hideNatives(row);
    if (document.getElementById(BUTTON_ID)) { return; }
    // First position: exactly where Play was.
    row.insertBefore(makeButton(id), row.firstChild);
    log('replaced the play button in', ROW);
  }

  function cleanup() {
    removeButton();
    restoreNatives();
  }

  /* ----------------------------------------------------------------- loop */

  function tick() {
    var id = currentItemId();
    if (!id) {
      if (state.itemId) { cleanup(); state.itemId = null; }
      return;
    }
    if (id !== state.itemId) {
      cleanup();
      state.itemId = id;
    }
    isInteractive(id, function (yes) {
      if (currentItemId() !== id) { return; }        // navigated away meanwhile
      if (!yes) { cleanup(); return; }
      place(id);
    });
  }

  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', tick);
  setInterval(tick, 1000);
  tick();
}());

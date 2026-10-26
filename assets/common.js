/*
 * 共用小工具：所有遊戲頁面都會載入。
 * 提供 KG.sound()、KG.note()、KG.say()、KG.confetti()、KG.toast()、
 * KG.showWin()、KG.showStart()、KG.best()、KG.rand()、KG.pick()、KG.shuffle()。
 * 頁面載入時會自動加上「回首頁」與「音效開關」按鈕。
 */
(function () {
  'use strict';

  var KG = {};
  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('kg:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem('kg:' + k, JSON.stringify(v)); } catch (e) { /* 私密模式等情況忽略 */ }
    }
  };
  KG.store = store;

  /* ---------- 效能：限制畫布解析度 ----------
   * 手機的像素密度常常是 3 倍，遊戲畫布照實際密度畫會很吃效能（安裝成 App 後
   * 沒有網址列、畫面更大，更明顯）。這裡把所有遊戲讀到的 devicePixelRatio
   * 限制在 2 倍，記憶體或核心少的手機限制在 1.5 倍，畫面幾乎看不出差別。 */
  var realDpr = window.devicePixelRatio || 1;
  var lowEnd = (navigator.deviceMemory && navigator.deviceMemory <= 4) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
  var dprCap = lowEnd ? 1.5 : 2;
  KG.lowEnd = !!lowEnd;
  if (realDpr > dprCap) {
    try {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: function () { return Math.min(realDpr, dprCap); } });
    } catch (e) { /* 改不了就照原本的 */ }
  }

  /* ---------- 音效 ---------- */
  var ctx = null;
  var muted = store.get('muted', false);

  function audio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // 第一次觸碰時解鎖音效（行動裝置需要）
  window.addEventListener('pointerdown', function () { audio(); }, { once: true, capture: true });

  /** 播放一個音符。freq 頻率(Hz)、dur 秒、type 波形、vol 音量、delay 延遲秒、slide 結束頻率 */
  KG.note = function (freq, dur, type, vol, delay, slide) {
    if (muted) return;
    var a = audio();
    if (!a) return;
    var t = a.currentTime + (delay || 0);
    var o = a.createOscillator();
    var g = a.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    var v = vol == null ? 0.25 : vol;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  };

  function noise(dur, vol, delay, freq) {
    if (muted) return;
    var a = audio();
    if (!a) return;
    var t = a.currentTime + (delay || 0);
    var len = Math.floor(a.sampleRate * dur);
    var buf = a.createBuffer(1, len, a.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = a.createBufferSource();
    src.buffer = buf;
    var f = a.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq || 1200;
    var g = a.createGain();
    g.gain.value = vol == null ? 0.3 : vol;
    src.connect(f); f.connect(g); g.connect(a.destination);
    src.start(t);
  }

  var SOUNDS = {
    click: function () { KG.note(660, 0.08, 'triangle', 0.2); },
    pop: function () { KG.note(500, 0.12, 'sine', 0.3, 0, 1200); },
    correct: function () { KG.note(660, 0.12, 'triangle', 0.25); KG.note(990, 0.2, 'triangle', 0.25, 0.1); },
    wrong: function () { KG.note(300, 0.18, 'square', 0.12, 0, 200); KG.note(220, 0.25, 'square', 0.12, 0.15, 150); },
    win: function () {
      [523, 659, 784, 1047].forEach(function (f, i) { KG.note(f, 0.22, 'triangle', 0.25, i * 0.12); });
      KG.note(1319, 0.5, 'sine', 0.2, 0.5);
    },
    lose: function () { [392, 330, 262].forEach(function (f, i) { KG.note(f, 0.3, 'triangle', 0.22, i * 0.18); }); },
    jump: function () { KG.note(300, 0.18, 'sine', 0.25, 0, 700); },
    coin: function () { KG.note(988, 0.08, 'square', 0.12); KG.note(1319, 0.25, 'square', 0.12, 0.08); },
    hit: function () { noise(0.12, 0.35, 0, 800); KG.note(160, 0.12, 'sine', 0.3, 0, 60); },
    whoosh: function () { noise(0.3, 0.2, 0, 2000); },
    splash: function () { noise(0.4, 0.3, 0, 600); KG.note(800, 0.15, 'sine', 0.15, 0.05, 300); },
    boing: function () { KG.note(180, 0.35, 'sine', 0.3, 0, 520); },
    tick: function () { KG.note(1200, 0.04, 'square', 0.08); },
    sparkle: function () { [1568, 2093, 2637].forEach(function (f, i) { KG.note(f, 0.15, 'sine', 0.12, i * 0.06); }); }
  };

  /** 播放內建音效：click pop correct wrong win lose jump coin hit whoosh splash boing tick sparkle */
  KG.sound = function (name) {
    try { if (SOUNDS[name]) SOUNDS[name](); } catch (e) { /* 忽略 */ }
  };

  KG.isMuted = function () { return muted; };
  KG.setMuted = function (m) {
    muted = !!m;
    store.set('muted', muted);
    if (muted && window.speechSynthesis) window.speechSynthesis.cancel();
    var b = document.querySelector('.kg-mute');
    if (b) b.textContent = muted ? '🔇' : '🔊';
  };

  /** 用中文語音念出文字（裝置不支援時安靜略過） */
  KG.say = function (text, rate) {
    if (muted || !window.speechSynthesis) return;
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-TW';
      u.rate = rate || 0.95;
      u.pitch = 1.25;
      var voices = window.speechSynthesis.getVoices();
      var v = voices.find(function (x) { return /zh[-_](TW|HK)/i.test(x.lang); }) ||
              voices.find(function (x) { return /^zh/i.test(x.lang); });
      if (v) u.voice = v;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { /* 忽略 */ }
  };

  /* ---------- 小工具 ---------- */
  KG.rand = function (a, b) { return a + Math.random() * (b - a); };
  KG.randInt = function (a, b) { return Math.floor(a + Math.random() * (b - a + 1)); };
  KG.pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };
  KG.shuffle = function (arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  };
  /** 讀取或更新最高分。給 value 時若比較高就寫入，回傳目前最高分 */
  KG.best = function (key, value, lowerIsBetter) {
    var cur = store.get('best:' + key, null);
    if (value != null && (cur == null || (lowerIsBetter ? value < cur : value > cur))) {
      cur = value;
      store.set('best:' + key, cur);
    }
    return cur;
  };
  KG.vibrate = function (ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 30); } catch (e) { /* 忽略 */ } };

  /* ---------- 畫面效果 ---------- */
  KG.toast = function (text) {
    var el = document.createElement('div');
    el.className = 'kg-toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 1150);
  };

  /** 彩帶慶祝。x、y 為起點（預設畫面中央） */
  KG.confetti = function (x, y, count) {
    var cv = document.getElementById('kg-confetti');
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'kg-confetti';
      document.body.appendChild(cv);
    }
    var dpr = window.devicePixelRatio || 1;
    cv.width = innerWidth * dpr;
    cv.height = innerHeight * dpr;
    var c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var colors = ['#ff8fb1', '#ffd65c', '#7bd88f', '#6cc4ff', '#b49cff', '#ffa94d'];
    var ox = x == null ? innerWidth / 2 : x;
    var oy = y == null ? innerHeight / 2.5 : y;
    var parts = [];
    for (var i = 0; i < (count || 120); i++) {
      var ang = Math.random() * Math.PI * 2;
      var sp = 4 + Math.random() * 9;
      parts.push({
        x: ox, y: oy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 5,
        w: 6 + Math.random() * 8, h: 4 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
        c: colors[i % colors.length], star: Math.random() < 0.25, life: 1
      });
    }
    var start = performance.now();
    (function frame(now) {
      c.clearRect(0, 0, innerWidth, innerHeight);
      var alive = false;
      parts.forEach(function (p) {
        p.vy += 0.25; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        p.life = 1 - (now - start) / 2600;
        if (p.life > 0 && p.y < innerHeight + 30) alive = true;
        c.save();
        c.globalAlpha = Math.max(0, p.life);
        c.translate(p.x, p.y);
        c.rotate(p.r);
        c.fillStyle = p.c;
        if (p.star) { c.font = (p.w * 2) + 'px sans-serif'; c.fillText('⭐', -p.w, p.w); }
        else c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        c.restore();
      });
      if (alive) requestAnimationFrame(frame); else c.clearRect(0, 0, innerWidth, innerHeight);
    })(start);
  };

  function overlay(html, buttons) {
    var ov = document.createElement('div');
    ov.className = 'kg-overlay';
    var card = document.createElement('div');
    card.className = 'kg-card';
    card.innerHTML = html;
    var acts = document.createElement('div');
    acts.className = 'kg-actions';
    buttons.forEach(function (b) {
      var btn = document.createElement(b.href ? 'a' : 'button');
      btn.className = 'kg-btn ' + (b.cls || '');
      btn.textContent = b.text;
      if (b.href) { btn.href = b.href; btn.style.textDecoration = 'none'; }
      btn.addEventListener('click', function () {
        KG.sound('click');
        if (!b.href) { ov.remove(); if (b.onClick) b.onClick(); }
      });
      acts.appendChild(btn);
    });
    card.appendChild(acts);
    ov.appendChild(card);
    document.body.appendChild(ov);
    return ov;
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }

  /**
   * 開始畫面。opts: { icon, title, message, button, onStart }
   */
  KG.showStart = function (opts) {
    return overlay(
      '<div class="kg-big kg-bounce">' + esc(opts.icon || '🎮') + '</div>' +
      '<h2>' + esc(opts.title || '') + '</h2>' +
      '<p>' + esc(opts.message || '') + '</p>',
      [{ text: opts.button || '開始玩！', cls: 'green', onClick: opts.onStart }]
    );
  };

  /**
   * 結算畫面。opts: { icon, title, message, stars(0-3), onReplay, replayText }
   */
  KG.showWin = function (opts) {
    var stars = '';
    if (opts.stars != null) {
      stars = '<div class="kg-stars">';
      for (var i = 0; i < 3; i++) stars += '<span class="' + (i < opts.stars ? '' : 'off') + '" style="animation-delay:' + (0.15 + i * 0.15) + 's">⭐</span>';
      stars += '</div>';
    }
    if (opts.stars == null || opts.stars > 0) { KG.sound('win'); KG.confetti(); } else KG.sound('lose');
    return overlay(
      '<div class="kg-big">' + esc(opts.icon || '🎉') + '</div>' +
      '<h2>' + esc(opts.title || '太棒了！') + '</h2>' + stars +
      '<p>' + esc(opts.message || '') + '</p>',
      [
        { text: opts.replayText || '再玩一次', cls: 'green', onClick: opts.onReplay },
        { text: '回首頁', cls: 'blue', href: homeHref() }
      ]
    );
  };

  function homeHref() {
    var s = document.querySelector('script[src*="assets/common.js"]');
    if (s) return s.getAttribute('src').replace(/assets\/common\.js.*$/, 'index.html');
    return '../../index.html';
  }

  /* ---------- 自動加上按鈕 ---------- */
  function addButtons() {
    if (document.body.dataset.kgNoButtons !== undefined) return;
    var home = document.createElement('a');
    home.className = 'kg-fab kg-home';
    home.href = homeHref();
    home.title = '回首頁';
    home.setAttribute('aria-label', '回首頁');
    home.textContent = '🏠';
    var mute = document.createElement('button');
    mute.className = 'kg-fab kg-mute';
    mute.title = '音效開關';
    mute.setAttribute('aria-label', '音效開關');
    mute.textContent = muted ? '🔇' : '🔊';
    mute.addEventListener('click', function () { KG.setMuted(!muted); if (!muted) KG.sound('click'); });
    document.body.appendChild(home);
    document.body.appendChild(mute);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addButtons);
  else addButtons();

  window.KG = KG;
})();

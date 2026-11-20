/*
 * 小朋友遊戲樂園：背景音樂與音效引擎（要在 common.js 之後載入）
 *
 *   <script src="../../assets/common.js"></script>
 *   <script src="../../assets/kg-music.js"></script>
 *
 * 背景音樂：KG.music.play(song)、stop()、setLayer(name, on)、setTempo(mult)、
 *           setEnabled(on)、isEnabled()、jingle(def)
 * 音效：    KG.sfx.play(name, {vol, pitch, pan})、KG.sfx.tone(...)、KG.sfx.noise(...)、KG.sfx.loop(kind)
 *
 * 曲子格式（全部用程式合成，不用音檔）：
 * {
 *   bpm: 112, steps: 16,          // 每小節幾格（16 = 十六分音符）
 *   swing: 0.12,                  // 0~0.5，偶數格往後推一點，聽起來比較有律動
 *   bars: 8,                      // 一輪幾小節（省略時 = chords 的長度）
 *   chords: ['C', 'Am', 'F', 'G'],// 每小節一個和弦（m, 7, maj7, m7, sus2, sus4, dim, aug, add9）
 *   tracks: [
 *     { inst: 'kick',  pat: 'x...x...x...x...' },                  // 鼓：x 一般、X 重音、o 輕；每小節重複
 *     { inst: 'hat',   pat: ['..x...x...x...x.', '..x...x...x.x.xx'] }, // 陣列 = 依小節輪流
 *     { inst: 'bass',  chord: 'R...R.5.R...R.8.' },                // 跟和弦：R 根音、3 5 7 8(高八度) 9
 *     { inst: 'pad',   chord: 'hold' },                            // 整小節長音和弦
 *     { inst: 'pluck', arp: 'up', rate: 2, oct: 4 },               // 分解和弦：up down updown random，rate 幾格一個音
 *     { inst: 'lead',  seq: ['E5 . G5 . A5 - - . G5 . E5 . D5 . C5 .', ''] },  // 旋律：每小節一字串，'-' 延長、'.' 休止、'' 整小節休息
 *     { inst: 'bell',  seq: [...], layer: 'top', vol: 0.6 }        // layer：可以用 setLayer 開關（越緊張越多樂器）
 *   ]
 * }
 * 樂器：lead pluck bell pad bass sub organ marimba flute chip strings brass kalimba
 *       kick snare hat ohat clap shaker tom rim crash
 */
(function () {
  var KG = window.KG;
  if (!KG) return;

  /* ---------- 共用聲音節點 ---------- */
  var A = null, master, comp, musicBus, musicOut, sfxBus, revIn, revOut, noiseBuf;
  var musicVol = 0.24, sfxVol = 0.9;

  function getCtx() {
    var a = KG.audio ? KG.audio() : null;
    if (!a) return null;
    if (a !== A) { A = a; build(); }
    return A;
  }
  function build() {
    comp = A.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    master = A.createGain(); master.gain.value = 1;
    master.connect(comp); comp.connect(A.destination);
    musicOut = A.createGain(); musicOut.gain.value = musicEnabled ? musicVol : 0; musicOut.connect(master);
    musicBus = A.createGain(); musicBus.gain.value = 1; musicBus.connect(musicOut);
    sfxBus = A.createGain(); sfxBus.gain.value = sfxVol; sfxBus.connect(master);
    // 殘響：自己產生的衝擊響應
    var conv = A.createConvolver();
    var len = Math.floor(A.sampleRate * 2.2), ir = A.createBuffer(2, len, A.sampleRate);
    for (var c = 0; c < 2; c++) {
      var d = ir.getChannelData(c);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    conv.buffer = ir;
    revIn = A.createGain(); revIn.gain.value = 1;
    revOut = A.createGain(); revOut.gain.value = 0.22;
    var hp = A.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 220;
    revIn.connect(hp); hp.connect(conv); conv.connect(revOut); revOut.connect(musicOut);
    var nl = A.sampleRate; noiseBuf = A.createBuffer(1, nl, A.sampleRate);
    var nd = noiseBuf.getChannelData(0);
    for (var j = 0; j < nl; j++) nd[j] = Math.random() * 2 - 1;
  }

  /* ---------- 音高 ---------- */
  var NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function midiOf(name) {
    var m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name);
    if (!m) return null;
    var n = NOTE[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return 12 * (+m[3] + 1) + n;
  }
  function hz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
  var CHORD = {
    '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], sus2: [0, 2, 7], sus4: [0, 5, 7],
    dim: [0, 3, 6], aug: [0, 4, 8], add9: [0, 4, 7, 14], m9: [0, 3, 7, 10, 14], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9]
  };
  function parseChord(s) {
    var m = /^([A-G])([#b]?)(.*)$/.exec(s || 'C');
    if (!m) return { root: 48, iv: CHORD[''] };
    var root = NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    var q = m[3].split('/')[0];
    return { root: 48 + root, iv: CHORD[q] || CHORD[''] };
  }

  /* ---------- 樂器 ---------- */
  function env(g, t, a, peak, dec, sus, rel, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * sus), t + a + dec);
    var end = Math.max(t + a + dec, t + dur);
    g.gain.setValueAtTime(Math.max(0.0001, peak * sus), end);
    g.gain.exponentialRampToValueAtTime(0.0001, end + rel);
    return end + rel;
  }
  function osc(type, f, t, end, out, detune) {
    var o = A.createOscillator();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (detune) o.detune.setValueAtTime(detune, t);
    o.connect(out); o.start(t); o.stop(end + 0.02);
    return o;
  }
  function chain(dest, pan, send) {
    var g = A.createGain();
    var node = g;
    if (pan && A.createStereoPanner) { var p = A.createStereoPanner(); p.pan.value = pan; g.connect(p); node = p; }
    node.connect(dest);
    if (send && revIn) { var s = A.createGain(); s.gain.value = send; node.connect(s); s.connect(revIn); }
    return g;
  }
  function lp(f, q, out) { var b = A.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = f; b.Q.value = q || 0.7; b.connect(out); return b; }
  function noiseSrc(t, end, out, rate) {
    var s = A.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    if (rate) s.playbackRate.value = rate;
    s.connect(out); s.start(t, Math.random() * 0.5); s.stop(end + 0.02);
    return s;
  }

  var INST = {
    lead: function (f, t, d, v, out) {
      var g = chain(out, 0.08, 0.25), end = env(g, t, 0.01, v * 0.16, 0.12, 0.7, 0.12, d);
      var fl = lp(Math.min(5200, f * 5), 1.2, g);
      var o1 = osc('square', f, t, end, fl, -6), o2 = osc('sawtooth', f, t, end, fl, 7);
      var lfo = A.createOscillator(), lg = A.createGain(); lfo.frequency.value = 5.2; lg.gain.value = f * 0.006;
      lfo.connect(lg); lg.connect(o1.frequency); lg.connect(o2.frequency); lfo.start(t + 0.12); lfo.stop(end);
    },
    pluck: function (f, t, d, v, out) {
      var g = chain(out, -0.15, 0.3), end = env(g, t, 0.004, v * 0.22, Math.min(0.5, d + 0.2), 0.001, 0.05, 0.01);
      var fl = A.createBiquadFilter(); fl.type = 'lowpass'; fl.Q.value = 2; fl.connect(g);
      fl.frequency.setValueAtTime(Math.min(9000, f * 8), t); fl.frequency.exponentialRampToValueAtTime(Math.max(200, f * 1.2), t + 0.25);
      osc('sawtooth', f, t, end, fl); osc('triangle', f * 2, t, end, fl);
    },
    bell: function (f, t, d, v, out) {
      var g = chain(out, 0.2, 0.45), end = env(g, t, 0.003, v * 0.16, 1.2, 0.001, 0.05, 0.01);
      osc('sine', f, t, end, g);
      var g2 = A.createGain(); g2.gain.setValueAtTime(0.35, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.4); g2.connect(g);
      osc('sine', f * 2.76, t, end, g2); osc('sine', f * 5.4, t, t + 0.3, g2);
    },
    kalimba: function (f, t, d, v, out) {
      var g = chain(out, -0.1, 0.35), end = env(g, t, 0.002, v * 0.2, 0.7, 0.001, 0.05, 0.01);
      osc('sine', f, t, end, g);
      var g2 = A.createGain(); g2.gain.setValueAtTime(0.25, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.08); g2.connect(g);
      osc('sine', f * 6.2, t, t + 0.1, g2);
    },
    marimba: function (f, t, d, v, out) {
      var g = chain(out, 0.12, 0.25), end = env(g, t, 0.002, v * 0.24, 0.45, 0.001, 0.04, 0.01);
      osc('sine', f, t, end, g);
      var g2 = A.createGain(); g2.gain.setValueAtTime(0.4, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.06); g2.connect(g);
      osc('sine', f * 4, t, t + 0.08, g2);
    },
    pad: function (f, t, d, v, out) {
      var g = chain(out, 0, 0.5), end = env(g, t, Math.min(0.35, d * 0.4), v * 0.07, 0.3, 0.8, 0.5, d);
      var fl = lp(Math.min(2400, f * 4), 0.6, g);
      osc('sawtooth', f, t, end, fl, -9); osc('sawtooth', f, t, end, fl, 9); osc('triangle', f / 2, t, end, fl);
    },
    strings: function (f, t, d, v, out) {
      var g = chain(out, -0.05, 0.45), end = env(g, t, Math.min(0.18, d * 0.3), v * 0.09, 0.2, 0.85, 0.35, d);
      var fl = lp(Math.min(3500, f * 6), 0.5, g);
      var a = osc('sawtooth', f, t, end, fl, -5), b = osc('sawtooth', f, t, end, fl, 6);
      var lfo = A.createOscillator(), lg = A.createGain(); lfo.frequency.value = 5.5; lg.gain.value = f * 0.004;
      lfo.connect(lg); lg.connect(a.frequency); lg.connect(b.frequency); lfo.start(t); lfo.stop(end);
    },
    brass: function (f, t, d, v, out) {
      var g = chain(out, 0.1, 0.25), end = env(g, t, 0.04, v * 0.13, 0.15, 0.75, 0.12, d);
      var fl = A.createBiquadFilter(); fl.type = 'lowpass'; fl.Q.value = 1; fl.connect(g);
      fl.frequency.setValueAtTime(f * 1.5, t); fl.frequency.linearRampToValueAtTime(Math.min(4000, f * 6), t + 0.06);
      osc('sawtooth', f, t, end, fl); osc('sawtooth', f, t, end, fl, 8);
    },
    organ: function (f, t, d, v, out) {
      var g = chain(out, 0, 0.3), end = env(g, t, 0.01, v * 0.1, 0.05, 0.9, 0.08, d);
      osc('sine', f, t, end, g); osc('sine', f * 2, t, end, g); osc('sine', f * 3, t, end, g);
    },
    flute: function (f, t, d, v, out) {
      var g = chain(out, 0.15, 0.4), end = env(g, t, 0.05, v * 0.17, 0.1, 0.8, 0.15, d);
      var o = osc('sine', f, t, end, g);
      var lfo = A.createOscillator(), lg = A.createGain(); lfo.frequency.value = 4.8; lg.gain.value = f * 0.008;
      lfo.connect(lg); lg.connect(o.frequency); lfo.start(t + 0.15); lfo.stop(end);
      var bg = A.createGain(); bg.gain.setValueAtTime(0.06, t); bg.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      var bp = A.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 3;
      bp.connect(bg); bg.connect(g); noiseSrc(t, t + 0.15, bp);
    },
    chip: function (f, t, d, v, out) {
      var g = chain(out, 0, 0.12), end = env(g, t, 0.003, v * 0.09, 0.05, 0.6, 0.04, d);
      osc('square', f, t, end, g);
    },
    bass: function (f, t, d, v, out) {
      var g = chain(out, 0, 0), end = env(g, t, 0.005, v * 0.32, 0.18, 0.55, 0.06, d);
      var fl = A.createBiquadFilter(); fl.type = 'lowpass'; fl.Q.value = 3; fl.connect(g);
      fl.frequency.setValueAtTime(f * 7, t); fl.frequency.exponentialRampToValueAtTime(f * 2.2, t + 0.15);
      osc('sawtooth', f, t, end, fl); osc('sine', f, t, end, g);
    },
    sub: function (f, t, d, v, out) {
      var g = chain(out, 0, 0), end = env(g, t, 0.006, v * 0.42, 0.1, 0.8, 0.07, d);
      osc('sine', f, t, end, g); osc('triangle', f, t, end, g);
    },
    /* 鼓 */
    kick: function (f, t, d, v, out) {
      var g = chain(out, 0, 0), end = env(g, t, 0.002, v * 0.9, 0.28, 0.001, 0.02, 0.01);
      var o = osc('sine', 150, t, end, g); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    },
    snare: function (f, t, d, v, out) {
      var g = chain(out, 0, 0.18), end = env(g, t, 0.001, v * 0.4, 0.17, 0.001, 0.02, 0.01);
      var hp = A.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200; hp.connect(g); noiseSrc(t, end, hp);
      var tg = A.createGain(); tg.gain.setValueAtTime(0.5, t); tg.gain.exponentialRampToValueAtTime(0.001, t + 0.09); tg.connect(g);
      var o = osc('triangle', 220, t, t + 0.1, tg); o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    },
    clap: function (f, t, d, v, out) {
      var g = chain(out, 0.1, 0.3);
      var bp = A.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 1.2; bp.connect(g);
      g.gain.setValueAtTime(0.0001, t);
      [0, 0.011, 0.022].forEach(function (o) { g.gain.setValueAtTime(v * 0.45, t + o); g.gain.exponentialRampToValueAtTime(v * 0.08, t + o + 0.009); });
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      noiseSrc(t, t + 0.22, bp);
    },
    hat: function (f, t, d, v, out) {
      var g = chain(out, 0.25, 0), end = env(g, t, 0.001, v * 0.13, 0.045, 0.001, 0.01, 0.01);
      var hp = A.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7500; hp.connect(g); noiseSrc(t, end, hp);
    },
    ohat: function (f, t, d, v, out) {
      var g = chain(out, 0.25, 0.1), end = env(g, t, 0.002, v * 0.11, 0.28, 0.001, 0.02, 0.01);
      var hp = A.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6500; hp.connect(g); noiseSrc(t, end, hp);
    },
    shaker: function (f, t, d, v, out) {
      var g = chain(out, -0.3, 0), end = env(g, t, 0.015, v * 0.08, 0.05, 0.001, 0.02, 0.01);
      var bp = A.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 6000; bp.Q.value = 0.8; bp.connect(g); noiseSrc(t, end, bp);
    },
    rim: function (f, t, d, v, out) {
      var g = chain(out, -0.1, 0.15), end = env(g, t, 0.001, v * 0.25, 0.04, 0.001, 0.01, 0.01);
      var bp = A.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 6; bp.connect(g);
      osc('square', 820, t, end, bp);
    },
    tom: function (f, t, d, v, out) {
      var g = chain(out, -0.15, 0.15), end = env(g, t, 0.002, v * 0.55, 0.3, 0.001, 0.02, 0.01);
      var o = osc('sine', f || 160, t, end, g); o.frequency.exponentialRampToValueAtTime((f || 160) * 0.55, t + 0.25);
    },
    crash: function (f, t, d, v, out) {
      var g = chain(out, 0, 0.3), end = env(g, t, 0.002, v * 0.16, 1.4, 0.001, 0.05, 0.01);
      var hp = A.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4500; hp.connect(g); noiseSrc(t, end, hp, 0.9);
    }
  };
  var DRUMS = { kick: 1, snare: 1, clap: 1, hat: 1, ohat: 1, shaker: 1, rim: 1, tom: 1, crash: 1 };

  /* ---------- 音樂播放器 ---------- */
  var musicEnabled = KG.store.get('music', true) !== false;
  var song = null, nextStep = 0, nextTime = 0, timer = null, tempoMult = 1, layers = {}, playing = false, wantPlay = false, held = false;
  var LOOK = 0.18;

  function prepTrack(tr) {
    var p = tr.pat || tr.seq || tr.chord;
    tr._bars = Array.isArray(p) ? p : (p != null ? [p] : null);
    if (tr.seq) {
      tr._seq = tr._bars.map(function (s) { return String(s).trim() ? String(s).trim().split(/\s+/) : []; });
    }
    if (tr.chord && tr.chord !== 'hold') tr._chordPat = tr._bars.map(function (s) { return String(s); });
  }
  function stepDur() { return 60 / (song.bpm * tempoMult) / (song.steps / 4); }
  function chordAt(bar) { var c = song.chords || ['C']; return parseChord(c[bar % c.length]); }

  function tokenAt(tokens, step, steps) {
    // 每個字代表 steps / tokens.length 格
    if (!tokens.length) return null;
    var per = steps / tokens.length;
    if (Math.abs(per - Math.round(per)) > 1e-6 || step % per) return null;
    var i = step / per, tok = tokens[i];
    if (tok === '.' || tok === '-') return null;
    var n = 1;
    while (i + n < tokens.length && tokens[i + n] === '-') n++;
    return { name: tok, len: n * per };
  }

  function scheduleStep(step, t) {
    var steps = song.steps, bar = Math.floor(step / steps), s = step % steps, sd = stepDur();
    var ch = chordAt(bar);
    for (var i = 0; i < song.tracks.length; i++) {
      var tr = song.tracks[i];
      if (tr.layer && layers[tr.layer] === false) continue;
      if (tr.from != null && bar % (song._len) < tr.from) continue;
      var vol = (tr.vol == null ? 1 : tr.vol), fn = INST[tr.inst];
      if (!fn) continue;
      var bi = tr.every ? Math.floor(bar / tr.every) : bar;
      if (DRUMS[tr.inst] && tr._bars) {
        var pat = tr._bars[bi % tr._bars.length], c = pat.charAt(Math.floor(s * pat.length / steps));
        if (pat.length !== steps && (s * pat.length) % steps) continue;
        if (c === 'x' || c === 'X' || c === 'o') fn(tr.pitch || 0, t, sd, vol * (c === 'X' ? 1 : c === 'x' ? 0.75 : 0.42), musicBus);
      } else if (tr._seq) {
        var tk = tokenAt(tr._seq[bi % tr._seq.length], s, steps);
        if (tk) {
          var names = tk.name.split('+');
          for (var k = 0; k < names.length; k++) {
            var m = midiOf(names[k]);
            if (m != null) fn(hz(m + (tr.transpose || 0)), t, tk.len * sd * (tr.legato || 0.92), vol, musicBus);
          }
        }
      } else if (tr.chord === 'hold') {
        var every = tr.rate || steps;
        if (s % every === 0) {
          var base = ch.root + 12 * ((tr.oct || 4) - 4);
          for (var q = 0; q < ch.iv.length; q++) fn(hz(base + ch.iv[q]), t, every * sd * 0.98, vol, musicBus);
        }
      } else if (tr._chordPat) {
        var cp = tr._chordPat[bi % tr._chordPat.length], cc = cp.charAt(Math.floor(s * cp.length / steps));
        if (cp.length !== steps && (s * cp.length) % steps) continue;
        var off = { R: 0, '1': 0, '3': ch.iv[1], '5': ch.iv[2], '7': ch.iv[3] != null ? ch.iv[3] : 10, '8': 12, '9': 14 }[cc];
        if (off == null) continue;
        var len = 1;
        var ps = steps / cp.length;
        for (var z = Math.floor(s / ps) + 1; z < cp.length && cp.charAt(z) === '-'; z++) len++;
        var octB = tr.oct != null ? tr.oct : (tr.inst === 'bass' || tr.inst === 'sub' ? 2 : 4);
        fn(hz(ch.root + 12 * (octB - 3) + off), t, len * ps * sd * 0.9, vol, musicBus);
      } else if (tr.arp) {
        var rate = tr.rate || 2;
        if (s % rate) continue;
        var notes = [], o4 = 12 * ((tr.oct || 4) - 3);
        for (var oc = 0; oc < (tr.span || 2); oc++) for (var w = 0; w < ch.iv.length; w++) notes.push(ch.root + o4 + ch.iv[w] + 12 * oc);
        var idx = s / rate, nn;
        if (tr.arp === 'down') nn = notes[notes.length - 1 - idx % notes.length];
        else if (tr.arp === 'updown') { var cyc = notes.length * 2 - 2, pp = idx % cyc; nn = notes[pp < notes.length ? pp : cyc - pp]; }
        else if (tr.arp === 'random') nn = notes[(idx * 7 + bar * 3) % notes.length];
        else nn = notes[idx % notes.length];
        fn(hz(nn), t, rate * sd * 0.9, vol, musicBus);
      }
    }
  }

  function tick() {
    if (!song || !A) return;
    var now = A.currentTime;
    if (nextTime < now - 0.3) nextTime = now + 0.05; // 卡頓太久就跳過，不要一次補一堆音
    while (nextTime < now + LOOK) {
      var s = nextStep % song.steps, sw = (s % 2 === 1) ? (song.swing || 0) * stepDur() : 0;
      scheduleStep(nextStep, nextTime + sw);
      nextStep = (nextStep + 1) % (song._len * song.steps);
      nextTime += stepDur();
    }
  }
  function start() {
    if (!song || playing || held || !musicEnabled || KG.isMuted() || document.hidden) return;
    var a = getCtx();
    if (!a) return;
    if (a.state !== 'running') {
      wantPlay = true;
      try { a.resume().then(function () { if (wantPlay) start(); }); } catch (e) { /* 忽略 */ }
      return;
    }
    playing = true; wantPlay = false;
    nextTime = a.currentTime + 0.08;
    musicOut.gain.cancelScheduledValues(a.currentTime);
    musicOut.gain.setValueAtTime(0.0001, a.currentTime);
    musicOut.gain.exponentialRampToValueAtTime(musicVol, a.currentTime + 0.6);
    timer = setInterval(tick, 30);
    tick();
  }
  function halt(fade) {
    if (timer) { clearInterval(timer); timer = null; }
    if (playing && A && musicOut) {
      var t = A.currentTime;
      musicOut.gain.cancelScheduledValues(t);
      musicOut.gain.setValueAtTime(musicOut.gain.value || 0.0001, t);
      musicOut.gain.exponentialRampToValueAtTime(0.0001, t + (fade || 0.25));
    }
    playing = false;
  }
  function unlockRetry() { if (wantPlay || (song && !playing)) setTimeout(start, 30); }
  window.addEventListener('pointerdown', unlockRetry, true);
  window.addEventListener('keydown', unlockRetry, true);
  window.addEventListener('touchend', unlockRetry, true);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) halt(0.05); else if (song) start();
  });
  // 跟著 🔊 靜音按鈕
  var origSetMuted = KG.setMuted;
  KG.setMuted = function (m) {
    origSetMuted(m);
    if (m) halt(0.1); else if (song) start();
  };

  KG.music = {
    /** 播放一首曲子（同一首正在播就不重來）。opts.restart 強制從頭 */
    play: function (s, opts) {
      if (!s) return;
      if (s === song && playing && !(opts && opts.restart)) return;
      halt(0.08);
      song = s;
      if (!s._ready) { s.steps = s.steps || 16; s.tracks.forEach(prepTrack); s._ready = true; }
      s._len = s.bars || (s.chords ? s.chords.length : 4);
      nextStep = 0; layers = Object.assign({}, s.layers || {});
      tempoMult = 1; held = false;
      setTimeout(start, 90);
    },
    stop: function (fade) { halt(fade || 0.4); song = null; wantPlay = false; held = false; },
    /** 遊戲暫停時呼叫；切回分頁也不會自己再播，直到 resume() */
    pause: function () { held = true; wantPlay = false; halt(0.15); },
    resume: function () { held = false; if (song) start(); },
    isPlaying: function () { return playing; },
    current: function () { return song; },
    /** 開關某一層樂器（曲子 track 的 layer 名稱） */
    setLayer: function (name, on) { layers[name] = !!on; },
    setTempo: function (mult) { tempoMult = Math.max(0.5, Math.min(2, mult || 1)); },
    setVolume: function (v) { musicVol = Math.max(0, Math.min(1, v)); if (musicOut && playing) musicOut.gain.setTargetAtTime(musicVol, A.currentTime, 0.1); },
    isEnabled: function () { return musicEnabled; },
    /** 背景音樂開關（記在瀏覽器，所有遊戲共用） */
    setEnabled: function (on) {
      musicEnabled = !!on; KG.store.set('music', musicEnabled);
      if (!musicEnabled) halt(0.2); else if (song) start();
    },
    /** 短樂句（過關、失敗、升級）：會暫時壓低背景音樂。def = {bpm, notes:[['C5',1],['E5',1],...] , inst, chord?} 或 曲子格式 */
    jingle: function (def) {
      if (KG.isMuted()) return 0;
      var a = getCtx(); if (!a) return 0;
      var t = a.currentTime + 0.03, spb = 60 / (def.bpm || 140) / 2, total = 0;
      var inst = INST[def.inst || 'bell'] || INST.bell;
      (def.notes || []).forEach(function (n) {
        var names = String(n[0]).split('+'), len = n[1] || 1;
        names.forEach(function (nm) { var m = midiOf(nm); if (m != null) inst(hz(m), t + total * spb, len * spb * 0.95, def.vol || 1, sfxBus); });
        total += len;
      });
      if (def.bass) def.bass.forEach(function (n, i) { var m = midiOf(n[0]); if (m != null) INST.sub(hz(m), t + n[2] * spb, n[1] * spb, 0.8, sfxBus); });
      var dur = total * spb;
      if (playing && musicOut) {
        musicOut.gain.setTargetAtTime(musicVol * 0.25, t, 0.05);
        musicOut.gain.setTargetAtTime(musicVol, t + dur + 0.1, 0.4);
      }
      return dur;
    },
    INST: INST,
    /** 測試用 */
    _nodes: function () { return A ? { ctx: A, comp: comp, musicOut: musicOut, sfxBus: sfxBus } : null; }
  };

  /* ---------- 音效 ---------- */
  function sfxOut(vol, pan) {
    var g = A.createGain(); g.gain.value = vol == null ? 1 : vol;
    if (pan && A.createStereoPanner) { var p = A.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(p); p.connect(sfxBus); }
    else g.connect(sfxBus);
    return g;
  }
  /** 一個音：tone(freq, dur, {type, vol, slide, delay, attack, out}) */
  function tone(f, d, o) {
    o = o || {};
    var t = A.currentTime + (o.delay || 0), out = o.out || sfxOut(1, o.pan);
    var g = A.createGain(); g.connect(out);
    var v = (o.vol == null ? 0.3 : o.vol);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + (o.attack || 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    var os = A.createOscillator(); os.type = o.type || 'sine';
    os.frequency.setValueAtTime(f, t);
    if (o.slide) os.frequency.exponentialRampToValueAtTime(Math.max(20, o.slide), t + d);
    os.connect(g); os.start(t); os.stop(t + d + 0.03);
  }
  /** 一段雜音：noise(dur, {vol, freq, q, type:'bandpass'|'lowpass'|'highpass', sweep, delay}) */
  function noiz(d, o) {
    o = o || {};
    var t = A.currentTime + (o.delay || 0), out = o.out || sfxOut(1, o.pan);
    var g = A.createGain(); g.connect(out);
    var v = o.vol == null ? 0.3 : o.vol;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    var f = A.createBiquadFilter(); f.type = o.type || 'bandpass'; f.frequency.setValueAtTime(o.freq || 1200, t); f.Q.value = o.q || 0.8;
    if (o.sweep) f.frequency.exponentialRampToValueAtTime(o.sweep, t + d);
    f.connect(g); noiseSrc(t, t + d, f);
  }
  function arp(notes, step, o) { notes.forEach(function (n, i) { tone(n, (o && o.len) || 0.18, Object.assign({}, o, { delay: ((o && o.delay) || 0) + i * step })); }); }

  var LIB = {
    click: function (p) { tone(880 * p, 0.05, { type: 'triangle', vol: 0.18 }); },
    ui: function (p) { tone(660 * p, 0.06, { type: 'triangle', vol: 0.16 }); tone(990 * p, 0.08, { type: 'sine', vol: 0.1, delay: 0.03 }); },
    select: function (p) { tone(520 * p, 0.09, { type: 'triangle', vol: 0.2, slide: 780 * p }); },
    back: function (p) { tone(620 * p, 0.09, { type: 'triangle', vol: 0.18, slide: 400 * p }); },
    pop: function (p) { tone(420 * p, 0.1, { vol: 0.3, slide: 1300 * p }); },
    bubble: function (p) { tone(300 * p, 0.12, { vol: 0.25, slide: 900 * p }); tone(700 * p, 0.06, { vol: 0.1, delay: 0.05, slide: 1400 * p }); },
    drop: function (p) { tone(900 * p, 0.16, { vol: 0.22, slide: 260 * p }); },
    thud: function (p) { tone(140 * p, 0.16, { vol: 0.45, slide: 55 }); noiz(0.08, { vol: 0.2, freq: 500, type: 'lowpass' }); },
    tap: function (p) { noiz(0.04, { vol: 0.25, freq: 2500 * p, q: 3 }); },
    swoosh: function (p) { noiz(0.28, { vol: 0.22, freq: 600 * p, sweep: 3200 * p, q: 1.5 }); },
    whoosh: function (p) { noiz(0.35, { vol: 0.25, freq: 2400 * p, sweep: 500, q: 1 }); },
    coin: function (p) { tone(988 * p, 0.07, { type: 'square', vol: 0.1 }); tone(1319 * p, 0.22, { type: 'square', vol: 0.1, delay: 0.07 }); },
    pickup: function (p) { arp([660 * p, 880 * p, 1320 * p], 0.045, { type: 'triangle', vol: 0.16, len: 0.12 }); },
    star: function (p) { arp([1047 * p, 1319 * p, 1568 * p, 2093 * p], 0.05, { vol: 0.13, len: 0.25 }); },
    sparkle: function (p) { arp([1568 * p, 2093 * p, 2637 * p, 3136 * p], 0.04, { vol: 0.09, len: 0.2 }); },
    correct: function (p) { tone(784 * p, 0.12, { type: 'triangle', vol: 0.22 }); tone(1175 * p, 0.28, { type: 'triangle', vol: 0.22, delay: 0.09 }); },
    wrong: function (p) { tone(330 * p, 0.16, { type: 'square', vol: 0.09, slide: 260 * p }); tone(247 * p, 0.26, { type: 'square', vol: 0.09, delay: 0.13, slide: 200 * p }); },
    error: function (p) { tone(180 * p, 0.18, { type: 'square', vol: 0.08 }); },
    powerup: function (p) { tone(300 * p, 0.45, { type: 'square', vol: 0.08, slide: 1200 * p }); arp([600 * p, 900 * p, 1200 * p], 0.08, { vol: 0.12, len: 0.15, delay: 0.25 }); },
    levelup: function (p) { arp([523 * p, 659 * p, 784 * p, 1047 * p, 1319 * p], 0.07, { type: 'triangle', vol: 0.18, len: 0.3 }); },
    unlock: function (p) { tone(523 * p, 0.12, { type: 'triangle', vol: 0.2 }); tone(784 * p, 0.12, { type: 'triangle', vol: 0.2, delay: 0.1 }); tone(1047 * p, 0.5, { vol: 0.2, delay: 0.2 }); },
    hit: function (p) { noiz(0.1, { vol: 0.35, freq: 900 * p }); tone(170 * p, 0.12, { vol: 0.3, slide: 60 }); },
    hurt: function (p) { tone(260 * p, 0.25, { type: 'sawtooth', vol: 0.12, slide: 90 }); noiz(0.12, { vol: 0.2, freq: 700 }); },
    explosion: function (p) { noiz(0.7, { vol: 0.5, freq: 900 * p, sweep: 80, type: 'lowpass', q: 0.7 }); tone(90 * p, 0.5, { vol: 0.45, slide: 35 }); },
    laser: function (p) { tone(1400 * p, 0.14, { type: 'sawtooth', vol: 0.08, slide: 300 * p }); },
    splash: function (p) { noiz(0.45, { vol: 0.3, freq: 1500 * p, sweep: 400, q: 0.6 }); tone(700 * p, 0.12, { vol: 0.12, slide: 300, delay: 0.03 }); },
    boing: function (p) { tone(170 * p, 0.35, { vol: 0.3, slide: 520 * p }); },
    jump: function (p) { tone(320 * p, 0.17, { type: 'triangle', vol: 0.22, slide: 760 * p }); },
    land: function (p) { noiz(0.08, { vol: 0.25, freq: 400 * p, type: 'lowpass' }); },
    tick: function (p) { tone(1300 * p, 0.035, { type: 'square', vol: 0.06 }); },
    countdown: function (p) { tone(660 * p, 0.14, { type: 'square', vol: 0.09 }); },
    go: function (p) { tone(1320 * p, 0.38, { type: 'square', vol: 0.1 }); tone(660 * p, 0.38, { type: 'triangle', vol: 0.12 }); },
    card: function (p) { noiz(0.06, { vol: 0.22, freq: 3000 * p, q: 0.7, type: 'highpass' }); },
    shuffle: function (p) { for (var i = 0; i < 6; i++) noiz(0.05, { vol: 0.14, freq: 2800 * p, q: 0.7, delay: i * 0.045, type: 'highpass' }); },
    dice: function (p) { for (var i = 0; i < 5; i++) noiz(0.035, { vol: 0.22, freq: 1800 + i * 300, q: 4, delay: i * 0.06 + Math.random() * 0.02 }); },
    snap: function (p) { noiz(0.03, { vol: 0.3, freq: 3500 * p, q: 2 }); tone(1800 * p, 0.04, { vol: 0.08 }); },
    win: function (p) { KG.music.jingle({ bpm: 150, inst: 'bell', notes: [['C5', 1], ['E5', 1], ['G5', 1], ['C6', 3]], bass: [['C3', 6, 0]] }); },
    lose: function (p) { KG.music.jingle({ bpm: 110, inst: 'pluck', notes: [['G4', 1], ['E4', 1], ['C4', 1], ['B3', 3]] }); }
  };

  KG.sfx = {
    /** 播放音效：名稱見下方 list()；opts.vol 音量倍數、opts.pitch 音高倍數、opts.pan -1~1 */
    play: function (name, opts) {
      if (KG.isMuted()) return;
      var a = getCtx(); if (!a || !LIB[name]) return;
      var o = opts || {}, p = o.pitch || 1;
      if (o.vol != null || o.pan) {
        var saved = sfxBus; sfxBus = A.createGain(); sfxBus.gain.value = o.vol == null ? 1 : o.vol;
        var tmp = sfxBus;
        if (o.pan && A.createStereoPanner) { var pn = A.createStereoPanner(); pn.pan.value = o.pan; tmp.connect(pn); pn.connect(saved); } else tmp.connect(saved);
        try { LIB[name](p); } finally { sfxBus = saved; }
      } else { try { LIB[name](p); } catch (e) { /* 忽略 */ } }
    },
    tone: function (f, d, o) { if (KG.isMuted() || !getCtx()) return; tone(f, d, o); },
    noise: function (d, o) { if (KG.isMuted() || !getCtx()) return; noiz(d, o); },
    /** 自己加音效：KG.sfx.define('zap', function (p, s) { s.tone(...); s.noise(...); }) */
    define: function (name, fn) { LIB[name] = function (p) { fn(p, KG.sfx); }; },
    list: function () { return Object.keys(LIB); },
    /** 持續的聲音（引擎、風聲、水流）：h = loop('engine'|'wind'|'water'|'hum'); h.set(0~1); h.stop() */
    loop: function (kind) {
      var a = getCtx(); if (!a) return { set: function () {}, stop: function () {} };
      var g = A.createGain(); g.gain.value = 0.0001; g.connect(sfxBus);
      var nodes = [], f = null, base = 1;
      if (kind === 'engine' || kind === 'hum') {
        f = A.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600; f.Q.value = 2; f.connect(g);
        var o1 = A.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = kind === 'hum' ? 110 : 55; o1.connect(f); o1.start();
        var o2 = A.createOscillator(); o2.type = 'square'; o2.frequency.value = (kind === 'hum' ? 110 : 55) * 1.5; o2.connect(f); o2.start();
        nodes.push(o1, o2); base = kind === 'hum' ? 110 : 55;
      } else {
        f = A.createBiquadFilter(); f.type = kind === 'water' ? 'lowpass' : 'bandpass'; f.frequency.value = kind === 'water' ? 900 : 500; f.Q.value = 0.9; f.connect(g);
        var s = A.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.connect(f); s.start(); nodes.push(s);
      }
      var vol = 0;
      return {
        set: function (x, v) {
          if (!A) return; x = Math.max(0, Math.min(1, x)); var t = A.currentTime;
          if (nodes[0].frequency) { nodes[0].frequency.setTargetAtTime(base * (1 + x * 3), t, 0.05); if (nodes[1]) nodes[1].frequency.setTargetAtTime(base * 1.5 * (1 + x * 3), t, 0.05); }
          f.frequency.setTargetAtTime((kind === 'water' ? 600 : 400) + x * 2400, t, 0.08);
          vol = (v == null ? 0.12 : v) * (KG.isMuted() || document.hidden ? 0 : 1);
          g.gain.setTargetAtTime(Math.max(0.0001, vol * (0.4 + x * 0.6)), t, 0.06);
        },
        stop: function () {
          if (!A) return; var t = A.currentTime; g.gain.setTargetAtTime(0.0001, t, 0.05);
          nodes.forEach(function (n) { try { n.stop(t + 0.3); } catch (e) { /* 忽略 */ } });
        }
      };
    },
    setVolume: function (v) { sfxVol = Math.max(0, Math.min(1.5, v)); if (sfxBus) sfxBus.gain.value = sfxVol; }
  };
})();

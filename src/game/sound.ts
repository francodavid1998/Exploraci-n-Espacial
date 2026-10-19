import * as THREE from 'three';

/**
 * Every sound of the game, all synthesised (no audio files), in both modes.
 *  - Music: slow pads that change with the place (space, ground, night), chosen at random
 *    from a pool of chords, in phrases with long silences between them, now and then a slow
 *    melody, and a key of its own for each world. A low pulse comes in during a fight
 *    (survival only), and calm pads play while paused, reading or at the end.
 *  - Ambience: wind where there is air, the hum of the engines, the jetpack.
 *  - Effects: the pulse engine, landings, footsteps, the weapons; and in survival the
 *    creatures (wet, organic: nothing sounds like a machine), placed where they are (3D),
 *    a low drone that rises with the danger and a heartbeat at low health.
 * Moderate levels and soft attacks: nothing ever blasts. N mutes; music and effects have
 * their own volume (both remembered). A real limiter sits at the end of the chain.
 */
export type Sfx =
  | 'shot' | 'cannon' | 'hit' | 'thud' | 'bolt' | 'rumble' | 'clank' | 'down' | 'chitter' | 'growl' | 'hiss' | 'shriek'
  | 'hurt' | 'blast' | 'dash' | 'heal' | 'vega' | 'whoosh' | 'land' | 'step' | 'creak' | 'splash' | 'chime';
export type Mood = 'space' | 'ground' | 'night' | 'calm' | 'end';
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
/** chords per mood (MIDI notes); a phrase picks a few of them at random, eight seconds each */
const CHORDS: Record<Mood, number[][]> = {
  ground: [[57, 60, 64], [53, 57, 64], [55, 60, 64], [52, 55, 59], [50, 57, 60], [53, 60, 65], [48, 55, 64], [55, 59, 62]],
  night: [[57, 58, 64], [53, 56, 62], [52, 55, 58], [50, 53, 57], [51, 55, 58], [49, 53, 56], [57, 60, 63]],
  space: [[69, 72, 76], [65, 69, 76], [67, 72, 76], [64, 67, 71], [62, 69, 74], [60, 67, 76], [65, 72, 77]],
  calm: [[60, 64, 67], [65, 69, 72], [57, 60, 64], [62, 65, 69], [55, 59, 62], [64, 67, 71]],
  // the end: a progression that resolves (played in order)
  end: [[53, 57, 60], [55, 59, 62], [57, 60, 64], [53, 57, 64], [55, 62, 67], [48, 55, 64]],
};
const KEY = 'helios-sound';
const VOL_KEY = 'helios-volume';
const IS_COARSE = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false);

/** what the game tells the sound every frame */
export interface SoundState {
  camQ: THREE.Quaternion;
  /** 1 = no sunlight at all */
  dark: number;
  /** danger nearby (0..1), survival only */
  tension: number;
  health: number;
  onFoot: boolean;
  /** realistic exploration: no fear sounds */
  explore: boolean;
  /** paused, dead, reading: the ambience fades out */
  frozen: boolean;
  /** density of the air around (0 in vacuum) */
  air: number;
  /** engine power 0..1 (ship), the jetpack firing (on foot) */
  engine: number;
  jet: boolean;
}

export class SoundFX {
  enabled = true;
  /** 0..1, remembered */
  musicVol = 0.8;
  sfxVol = 0.9;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private noise!: AudioBuffer;
  private amb: { drone: GainNode; wind: GainNode; windF: BiquadFilterNode; engine: GainNode; engineO: OscillatorNode; jet: GainNode } | null = null;
  private beatT = 0;
  private music: { gain: GainNode; filter: BiquadFilterNode; nextChord: number; last: number; left: number; nextBeat: number; beat: number; mood: Mood; endStep: number } | null = null;
  /** the last value asked of each parameter: only changes are scheduled */
  private targets = new Map<AudioParam, number>();
  private chitterUntil: number[] = [];

  constructor() {
    try {
      this.enabled = localStorage.getItem(KEY) !== '0';
      const v = JSON.parse(localStorage.getItem(VOL_KEY) ?? 'null') as { m?: number; s?: number } | null;
      if (v && typeof v.m === 'number' && typeof v.s === 'number') { this.musicVol = clamp01(v.m); this.sfxVol = clamp01(v.s); }
    } catch { /* ignore */ }
  }

  get ready() { return !!this.ctx; }

  /** must run inside a user gesture (browsers keep audio locked until one) */
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.45 : 0;
    // a real limiter at the end: nothing ever gets loud
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -6; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.25;
    this.master.connect(lim).connect(ctx.destination);
    this.musicBus = ctx.createGain(); this.musicBus.gain.value = this.musicVol; this.musicBus.connect(this.master);
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = this.sfxVol; this.sfxBus.connect(this.master);
    const n = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = n;
    // the drone of fear: two detuned low tones
    const drone = ctx.createGain(); drone.gain.value = 0;
    for (const f of [41.2, 41.9, 61.7]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = f > 60 ? 0.25 : 0.5;
      o.connect(og).connect(drone); o.start();
    }
    drone.connect(this.sfxBus);
    // wind: filtered noise, brighter in thick air
    const src = ctx.createBufferSource(); src.buffer = n; src.loop = true;
    const windF = ctx.createBiquadFilter(); windF.type = 'lowpass'; windF.frequency.value = 320;
    const wind = ctx.createGain(); wind.gain.value = 0;
    src.connect(windF).connect(wind).connect(this.sfxBus); src.start();
    // the engines: a low hum felt through the hull (no highs)
    const engineO = ctx.createOscillator(); engineO.type = 'sawtooth'; engineO.frequency.value = 46;
    const elp = ctx.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 160; elp.Q.value = 0.7;
    const engine = ctx.createGain(); engine.gain.value = 0;
    engineO.connect(elp).connect(engine).connect(this.sfxBus); engineO.start();
    // the jetpack: a soft hiss
    const js = ctx.createBufferSource(); js.buffer = n; js.loop = true;
    const jf = ctx.createBiquadFilter(); jf.type = 'bandpass'; jf.frequency.value = 900; jf.Q.value = 0.6;
    const jet = ctx.createGain(); jet.gain.value = 0;
    js.connect(jf).connect(jet).connect(this.sfxBus); js.start();
    this.amb = { drone, wind, windF, engine, engineO, jet };
    // music bus: pads through a soft low-pass, and a short echo
    const mg = ctx.createGain(); mg.gain.value = 0;
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 650; filter.Q.value = 0.6;
    const echo = ctx.createDelay(1.5); echo.delayTime.value = 0.42;
    const fb = ctx.createGain(); fb.gain.value = 0.32;
    filter.connect(mg); filter.connect(echo); echo.connect(fb).connect(echo); echo.connect(mg);
    mg.connect(this.musicBus);
    this.music = { gain: mg, filter, nextChord: ctx.currentTime + 1.5, last: -1, left: 4, nextBeat: 0, beat: 0, mood: 'ground', endStep: 0 };
  }

  /** a parameter eased towards a value, scheduled only when the value really changes */
  private ease(p: AudioParam, v: number, tc: number) {
    const last = this.targets.get(p);
    if (last !== undefined && Math.abs(last - v) <= Math.max(0.002, Math.abs(last) * 0.02)) return;
    this.targets.set(p, v);
    p.setTargetAtTime(v, this.ctx!.currentTime, tc);
  }

  setVolumes(music: number, sfx: number) {
    this.musicVol = clamp01(music);
    this.sfxVol = clamp01(sfx);
    try { localStorage.setItem(VOL_KEY, JSON.stringify({ m: this.musicVol, s: this.sfxVol })); } catch { /* ignore */ }
    if (this.ctx) { this.ease(this.musicBus.gain, this.musicVol, 0.1); this.ease(this.sfxBus.gain, this.sfxVol, 0.1); }
  }

  toggle() {
    this.enabled = !this.enabled;
    try { localStorage.setItem(KEY, this.enabled ? '1' : '0'); } catch { /* ignore */ }
    if (this.ctx) this.ease(this.master.gain, this.enabled ? 0.45 : 0, 0.1);
    return this.enabled;
  }

  /** the tab is hidden: everything stops (and starts again when it comes back) */
  suspend() { void this.ctx?.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume(); }

  /** per frame: the music follows the place and the danger (0..1); `key` transposes it (semitones, a key per world) */
  updateMusic(mood: Mood, danger: number, key = 0) {
    const ctx = this.ctx, m = this.music;
    if (!ctx || !m || ctx.state !== 'running') return;
    if (!Number.isFinite(danger)) danger = 0;
    const t = ctx.currentTime;
    if (mood !== m.mood) {
      // a new place: the next chord comes soon, in the new mood
      if (mood === 'end') m.endStep = 0;
      m.mood = mood;
      m.left = 3 + Math.floor(Math.random() * 3);
      if (m.nextChord > t + 3) m.nextChord = t + 2;
    }
    const level = mood === 'space' ? 0.16 : mood === 'calm' ? 0.11 : mood === 'end' ? 0.15 : 0.14;
    this.ease(m.gain.gain, this.enabled ? level + danger * 0.06 : 0, 1.5);
    this.ease(m.filter.frequency, mood === 'space' ? 1300 : mood === 'night' ? 420 : mood === 'calm' ? 700 : mood === 'end' ? 900 : 650, 2);
    // muted: no notes are scheduled at all
    if (!this.enabled || this.musicVol <= 0.001) { m.nextChord = Math.max(m.nextChord, t + 1); return; }
    if (t >= m.nextChord - 0.1) {
      const at = Math.max(t, m.nextChord);
      // the end plays its progression once, then calm phrases with silences between them
      const resolved = mood === 'end' && m.endStep >= CHORDS.end.length;
      const pool = CHORDS[resolved ? 'calm' : mood];
      let i: number;
      if (mood === 'end' && !resolved) i = m.endStep++;
      else { do i = Math.floor(Math.random() * pool.length); while (pool.length > 1 && i === m.last); }
      m.last = i;
      // now and then the chord is voiced an octave lower or with its root on top
      const inv = Math.random();
      const chord = pool[i].map((n, k) => n + key + (inv < 0.2 && k === 0 ? 12 : 0) + (inv > 0.85 ? -12 : 0));
      const wave: OscillatorType = mood === 'space' || mood === 'calm' || mood === 'end' ? 'triangle' : 'sawtooth';
      for (const n of chord) {
        for (const det of [-7, 7]) {
          const o = ctx.createOscillator();
          o.type = wave;
          o.frequency.value = midi(n);
          o.detune.value = det;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, at);
          g.gain.linearRampToValueAtTime(0.045, at + 2.5);
          g.gain.setValueAtTime(0.045, at + 7);
          g.gain.linearRampToValueAtTime(0.0001, at + 10.5);
          o.connect(g).connect(m.filter);
          o.start(at); o.stop(at + 11);
        }
      }
      // a deep root under the night
      if (mood === 'night') {
        const o = ctx.createOscillator(); o.frequency.value = midi(chord[0] - 24);
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(0.06, at + 3); g.gain.linearRampToValueAtTime(0.0001, at + 10.5);
        o.connect(g).connect(m.gain); o.start(at); o.stop(at + 11);
      }
      // sometimes a slow melody of two to four notes over the chord
      if (Math.random() < 0.3 && danger < 0.5) {
        const notes = 2 + Math.floor(Math.random() * 3);
        for (let k = 0; k < notes; k++) {
          const nt = at + 1.5 + k * 1.6;
          const o = ctx.createOscillator(); o.type = 'sine';
          o.frequency.value = midi(chord[Math.floor(Math.random() * chord.length)] + 12);
          const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, nt); g.gain.linearRampToValueAtTime(0.03, nt + 0.4); g.gain.exponentialRampToValueAtTime(0.0001, nt + 2.2);
          o.connect(g).connect(m.filter); o.start(nt); o.stop(nt + 2.3);
        }
      }
      m.nextChord = at + 8;
      // a phrase is a few chords; then, unless there is danger, a long silence
      if (--m.left <= 0) {
        m.left = 3 + Math.floor(Math.random() * 4);
        if (danger < 0.3 && (mood !== 'end' || m.endStep >= CHORDS.end.length)) m.nextChord += 20 + Math.random() * 40;
      }
    }
    // a fight: a low pulse at 96 bpm and a muffled ostinato
    if (danger > 0.55) {
      if (m.nextBeat < t) m.nextBeat = t + 0.05;
      if (m.nextChord > t + 8) m.nextChord = t + 4; // no silence in a fight
      while (m.nextBeat < t + 0.25) {
        const bt = m.nextBeat, i = m.beat++;
        if (i % 2 === 0) {
          const o = ctx.createOscillator(); o.frequency.setValueAtTime(75, bt); o.frequency.exponentialRampToValueAtTime(38, bt + 0.2);
          const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, bt); g.gain.linearRampToValueAtTime(0.13 * danger, bt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, bt + 0.25);
          o.connect(g).connect(m.gain); o.start(bt); o.stop(bt + 0.3);
        }
        const arp = [45, 52, 48, 52];
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = midi(arp[i % 4] + key);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, bt); g.gain.linearRampToValueAtTime(0.025 * danger, bt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, bt + 0.28);
        o.connect(lp).connect(g).connect(m.gain); o.start(bt); o.stop(bt + 0.3);
        m.nextBeat += 0.3125;
      }
    }
  }

  /** per frame: listener orientation (camera), ambience, the drone of fear, the heartbeat */
  update(dt: number, s: SoundState) {
    const ctx = this.ctx, a = this.amb;
    if (!ctx || !a) return;
    const l = ctx.listener;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(s.camQ), u = new THREE.Vector3(0, 1, 0).applyQuaternion(s.camQ);
    // audio parameters throw on NaN/Infinity: sound must never be able to stop the game
    if (![f.x, f.y, f.z, u.x, u.y, u.z, s.dark, s.tension, s.health, s.air, s.engine].every(Number.isFinite)) return;
    if (l.forwardX) {
      l.forwardX.value = f.x; l.forwardY.value = f.y; l.forwardZ.value = f.z;
      l.upX.value = u.x; l.upY.value = u.y; l.upZ.value = u.z;
    } else l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    const live = !s.frozen;
    const fear = !s.explore && live;
    this.ease(a.drone.gain, fear ? (s.onFoot ? 0.05 + 0.12 * s.dark + 0.25 * s.tension : 0.03) : 0, 0.8);
    const air = Math.min(1, s.air);
    this.ease(a.wind.gain, live && air > 0.001 ? (s.onFoot ? 0.03 + 0.05 * air + (fear ? 0.04 * s.dark : 0) : 0.02 + 0.06 * air * s.engine) : 0, 1.2);
    this.ease(a.windF.frequency, 220 + 420 * air, 2);
    this.ease(a.engine.gain, live && !s.onFoot ? 0.025 + 0.075 * s.engine : 0, 0.4);
    this.ease(a.engineO.frequency, 42 + 26 * s.engine, 0.6);
    this.ease(a.jet.gain, live && s.jet ? 0.07 : 0, 0.12);
    // heartbeat under 35% health, faster as it drops (survival)
    if (fear && s.onFoot && s.health < 35) {
      this.beatT -= dt;
      if (this.beatT <= 0) {
        const t = ctx.currentTime;
        this.beatT = 0.55 + (s.health / 35) * 0.5;
        this.thump(t, 0.18); this.thump(t + 0.16, 0.12);
      }
    }
  }

  private thump(t: number, v: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g).connect(this.sfxBus); o.start(t); o.stop(t + 0.25);
  }

  /**
   * One sound; `at` = position relative to the camera (world axes, metres) for 3D placement;
   * `tone` shifts its pitch (footsteps: 0 snow, 1 rock). Every play varies a little in pitch and level.
   */
  play(name: Sfx, at?: THREE.Vector3, tone = 0.5) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    // the same click a hundred times must not sound like a machine gun
    const rate = 1 + (Math.random() - 0.5) * 0.08, vol = 1 + (Math.random() - 0.5) * 0.3;
    let out: AudioNode = this.sfxBus;
    if (at && ![at.x, at.y, at.z].every(Number.isFinite)) at = undefined;
    if (name === 'chitter') {
      // never more than three creatures clicking at once
      this.chitterUntil = this.chitterUntil.filter((e) => e > t);
      if (this.chitterUntil.length >= 3) return;
      this.chitterUntil.push(t + 0.5);
    }
    if (at) {
      const p = ctx.createPanner();
      p.panningModel = IS_COARSE ? 'equalpower' : 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 4; p.rolloffFactor = 1.2; p.maxDistance = 400;
      if (p.positionX) { p.positionX.value = at.x; p.positionY.value = at.y; p.positionZ.value = at.z; } else p.setPosition(at.x, at.y, at.z);
      p.connect(this.sfxBus);
      out = p;
    }
    const env = (peak: number, a: number, dcy: number, t0 = 0) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + t0); g.gain.linearRampToValueAtTime(peak * vol, t + t0 + a); g.gain.exponentialRampToValueAtTime(0.0001, t + t0 + a + dcy);
      g.connect(out);
      return g;
    };
    const osc = (type: OscillatorType, f0: number, f1: number, dur: number, dest: AudioNode, t0 = 0) => {
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0 * rate, t + t0); o.frequency.exponentialRampToValueAtTime(Math.max(f1 * rate, 1), t + t0 + dur);
      o.connect(dest); o.start(t + t0); o.stop(t + t0 + dur + 0.05);
      return o;
    };
    const noise = (dur: number, type: BiquadFilterType, freq: number, q: number, dest: AudioNode, at0 = 0, sweep?: number) => {
      const s = ctx.createBufferSource(); s.buffer = this.noise;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq * rate, t + at0); f.Q.value = q;
      if (sweep) f.frequency.exponentialRampToValueAtTime(sweep * rate, t + at0 + dur);
      s.connect(f).connect(dest); s.start(t + at0, Math.random()); s.stop(t + at0 + dur);
    };
    switch (name) {
      case 'shot': { osc('sine', 1300, 240, 0.16, env(0.22, 0.004, 0.16)); noise(0.06, 'highpass', 3000, 0.7, env(0.06, 0.002, 0.06)); break; }
      // the ship's cannons: deeper and heavier than the rifle
      case 'cannon': { osc('sine', 260, 55, 0.3, env(0.24, 0.004, 0.3)); noise(0.14, 'lowpass', 900, 0.7, env(0.14, 0.003, 0.14)); break; }
      case 'hit': noise(0.09, 'lowpass', 1400, 0.8, env(0.25, 0.003, 0.1)); break;
      // a hit on something big and alive: wet and low
      case 'thud': { osc('sine', 90, 48, 0.22, env(0.3, 0.004, 0.22)); noise(0.16, 'lowpass', 320, 0.9, env(0.22, 0.004, 0.16)); break; }
      case 'bolt': { const g = env(0.16, 0.01, 0.35); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.connect(g); osc('square', 240, 90, 0.35, lp); break; }
      // a watcher waking: a slow growl rising from deep inside it (no siren)
      case 'rumble': {
        const g = env(0.22, 0.3, 1.1);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380; lp.connect(g);
        const am = ctx.createGain(); am.gain.value = 0.6; am.connect(lp);
        const lfo = ctx.createOscillator(); lfo.frequency.value = 6; const lg = ctx.createGain(); lg.gain.value = 0.35;
        lfo.connect(lg).connect(am.gain); lfo.start(t); lfo.stop(t + 1.5);
        osc('sawtooth', 55, 72, 1.4, am);
        break;
      }
      // stone and metal (the Spire's pylons)
      case 'clank': { osc('triangle', 520, 300, 0.12, env(0.18, 0.002, 0.14)); noise(0.05, 'bandpass', 2500, 3, env(0.1, 0.002, 0.05)); break; }
      case 'down': { const g = env(0.25, 0.01, 1.4); osc('sawtooth', 160, 30, 1.4, g); noise(1.0, 'lowpass', 600, 0.7, env(0.2, 0.02, 1.0)); break; }
      case 'chitter': {
        // a burst of dry clicks
        const n = 5 + Math.floor(Math.random() * 6);
        for (let i = 0; i < n; i++) {
          const g = ctx.createGain(); const tt = t + i * (0.04 + Math.random() * 0.035);
          g.gain.setValueAtTime(0.0001, tt); g.gain.linearRampToValueAtTime(0.22 * vol, tt + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.03);
          g.connect(out);
          const s = ctx.createBufferSource(); s.buffer = this.noise;
          const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2200 + Math.random() * 1800; f.Q.value = 9;
          s.connect(f).connect(g); s.start(tt, Math.random()); s.stop(tt + 0.04);
        }
        break;
      }
      case 'growl': {
        const g = env(0.28, 0.05, 0.75);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520; lp.connect(g);
        const am = ctx.createGain(); am.gain.value = 0.6; am.connect(lp);
        const lfo = ctx.createOscillator(); lfo.frequency.value = 9; const lg = ctx.createGain(); lg.gain.value = 0.4;
        lfo.connect(lg).connect(am.gain); lfo.start(t); lfo.stop(t + 0.9);
        osc('sawtooth', 85, 60, 0.85, am);
        break;
      }
      case 'hiss': noise(0.5, 'highpass', 2500, 0.5, env(0.12, 0.05, 0.45)); break;
      case 'shriek': { const g = env(0.16, 0.03, 0.7); const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 2; bp.connect(g); osc('sawtooth', 900, 300, 0.7, bp); break; }
      case 'hurt': { osc('sine', 130, 60, 0.22, env(0.3, 0.005, 0.22)); noise(0.12, 'lowpass', 800, 0.7, env(0.12, 0.004, 0.12)); break; }
      case 'blast': { noise(0.22, 'lowpass', 1800, 0.7, env(0.3, 0.004, 0.25)); osc('sine', 300, 60, 0.25, env(0.2, 0.004, 0.25)); break; }
      case 'dash': noise(0.25, 'bandpass', 900, 1.5, env(0.12, 0.03, 0.22)); break;
      case 'heal': { const g = env(0.12, 0.05, 0.6); osc('sine', 520, 780, 0.6, g); break; }
      case 'vega': { osc('sine', 880, 880, 0.12, env(0.05, 0.01, 0.15)); osc('sine', 1320, 1320, 0.25, env(0.05, 0.01, 0.22, 0.12), 0.12); break; }
      // the pulse engine: a slow rising (or falling) breath of air, 1.4 s
      case 'whoosh': noise(1.4, 'bandpass', tone > 0.5 ? 220 : 1600, 0.8, env(0.16, 0.5, 0.9), 0, tone > 0.5 ? 1600 : 220); break;
      // touchdown: a soft heavy thump through the hull
      case 'land': { osc('sine', 70, 34, 0.45, env(0.3, 0.01, 0.45)); noise(0.3, 'lowpass', 260, 0.7, env(0.16, 0.01, 0.3)); break; }
      // a footstep: muffled crunch, lower on snow and dust, a little brighter on rock
      case 'step': noise(0.09, 'bandpass', 380 + 900 * tone, 1.1, env(0.07, 0.006, 0.08)); break;
      // a crate lid on its hinge: a short soft creak and the air of the seal
      case 'creak': { const g = env(0.06, 0.08, 0.35); const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 6; bp.connect(g); osc('sawtooth', 160, 120, 0.4, bp); noise(0.4, 'highpass', 1800, 0.5, env(0.05, 0.1, 0.3)); break; }
      case 'splash': { noise(0.6, 'lowpass', 1500, 0.6, env(0.14, 0.01, 0.55), 0, 300); osc('sine', 180, 60, 0.3, env(0.08, 0.01, 0.3)); break; }
      // something found: two soft notes
      case 'chime': { osc('sine', 660, 660, 0.5, env(0.07, 0.02, 0.5)); osc('sine', 990, 990, 0.6, env(0.06, 0.02, 0.6, 0.18), 0.18); break; }
    }
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
  }
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }

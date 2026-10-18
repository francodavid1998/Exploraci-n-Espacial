import * as THREE from 'three';

/**
 * Survival mode's sounds, all synthesised (no audio files): a low drone that rises with
 * the danger, the creatures' clicking and growls placed where they are (3D), the
 * sentinels, the weapon, and a heartbeat at low health. Moderate levels, soft attacks:
 * horror by ear, never a blast. N mutes (remembered).
 */
export type Sfx = 'shot' | 'hit' | 'bolt' | 'alert' | 'clank' | 'down' | 'chitter' | 'growl' | 'hiss' | 'shriek' | 'hurt';
const KEY = 'helios-sound';

export class SoundFX {
  enabled = true;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private drone: { gain: GainNode; wind: GainNode } | null = null;
  private beatT = 0;

  constructor() {
    try { this.enabled = localStorage.getItem(KEY) !== '0'; } catch { /* ignore */ }
  }

  /** must run inside a user gesture (browsers keep audio locked until one) */
  init() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.55 : 0;
    // a gentle limiter: nothing ever gets loud
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 6;
    this.master.connect(comp).connect(ctx.destination);
    const n = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = n;
    // the drone: two detuned low tones and a dark wind
    const gain = ctx.createGain(); gain.gain.value = 0;
    for (const f of [41.2, 41.9, 61.7]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = f > 60 ? 0.25 : 0.5;
      o.connect(og).connect(gain); o.start();
    }
    const src = ctx.createBufferSource(); src.buffer = n; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320;
    const wind = ctx.createGain(); wind.gain.value = 0;
    src.connect(lp).connect(wind).connect(this.master); src.start();
    gain.connect(this.master);
    this.drone = { gain, wind };
  }

  toggle() {
    this.enabled = !this.enabled;
    try { localStorage.setItem(KEY, this.enabled ? '1' : '0'); } catch { /* ignore */ }
    if (this.ctx) this.master.gain.setTargetAtTime(this.enabled ? 0.55 : 0, this.ctx.currentTime, 0.1);
    return this.enabled;
  }

  /** per frame: listener orientation (camera), darkness, danger and health */
  update(dt: number, camQ: THREE.Quaternion, dark: number, tension: number, health: number, onFoot: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.drone) return;
    const l = ctx.listener;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camQ), u = new THREE.Vector3(0, 1, 0).applyQuaternion(camQ);
    if (l.forwardX) {
      l.forwardX.value = f.x; l.forwardY.value = f.y; l.forwardZ.value = f.z;
      l.upX.value = u.x; l.upY.value = u.y; l.upZ.value = u.z;
      l.positionX.value = 0; l.positionY.value = 0; l.positionZ.value = 0;
    } else l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    const t = ctx.currentTime;
    this.drone.gain.gain.setTargetAtTime(onFoot ? 0.05 + 0.12 * dark + 0.25 * tension : 0.03, t, 0.8);
    this.drone.wind.gain.setTargetAtTime(onFoot ? 0.04 + 0.06 * dark : 0, t, 1.2);
    // heartbeat under 35% health, faster as it drops
    if (onFoot && health < 35) {
      this.beatT -= dt;
      if (this.beatT <= 0) {
        this.beatT = 0.55 + (health / 35) * 0.5;
        this.thump(t, 0.18); this.thump(t + 0.16, 0.12);
      }
    }
  }

  private thump(t: number, v: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.25);
  }

  /** one sound; `at` = position relative to the camera (world axes, metres) for 3D placement */
  play(name: Sfx, at?: THREE.Vector3) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    let out: AudioNode = this.master;
    if (at) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 4; p.rolloffFactor = 1.2; p.maxDistance = 400;
      if (p.positionX) { p.positionX.value = at.x; p.positionY.value = at.y; p.positionZ.value = at.z; } else p.setPosition(at.x, at.y, at.z);
      p.connect(this.master);
      out = p;
    }
    const env = (peak: number, a: number, dcy: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + dcy);
      g.connect(out);
      return g;
    };
    const osc = (type: OscillatorType, f0: number, f1: number, dur: number, dest: AudioNode) => {
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
      o.connect(dest); o.start(t); o.stop(t + dur + 0.05);
      return o;
    };
    const noise = (dur: number, type: BiquadFilterType, freq: number, q: number, dest: AudioNode, at0 = 0) => {
      const s = ctx.createBufferSource(); s.buffer = this.noise;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      s.connect(f).connect(dest); s.start(t + at0, Math.random()); s.stop(t + at0 + dur);
    };
    switch (name) {
      case 'shot': { osc('sine', 1300, 240, 0.16, env(0.22, 0.004, 0.16)); noise(0.06, 'highpass', 3000, 0.7, env(0.06, 0.002, 0.06)); break; }
      case 'hit': noise(0.09, 'lowpass', 1400, 0.8, env(0.25, 0.003, 0.1)); break;
      case 'bolt': { const g = env(0.16, 0.01, 0.35); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.connect(g); osc('square', 240, 90, 0.35, lp); break; }
      case 'alert': { const g = env(0.14, 0.15, 0.9); osc('sawtooth', 110, 165, 1.0, g); osc('sine', 220, 330, 1.0, g); break; }
      case 'clank': { osc('triangle', 520, 300, 0.12, env(0.18, 0.002, 0.14)); noise(0.05, 'bandpass', 2500, 3, env(0.1, 0.002, 0.05)); break; }
      case 'down': { const g = env(0.25, 0.01, 1.4); osc('sawtooth', 160, 30, 1.4, g); noise(1.0, 'lowpass', 600, 0.7, env(0.2, 0.02, 1.0)); break; }
      case 'chitter': {
        // a burst of dry clicks
        const n = 5 + Math.floor(Math.random() * 6);
        for (let i = 0; i < n; i++) {
          const g = ctx.createGain(); const tt = t + i * (0.04 + Math.random() * 0.035);
          g.gain.setValueAtTime(0.0001, tt); g.gain.linearRampToValueAtTime(0.22, tt + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.03);
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
    }
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
  }
}

import type { SoundFX } from './sound';

/**
 * VEGA, the ship's computer: the pilot's only company. Short lines on screen (typed out,
 * then fading), a soft chime; never more than one at a time and never repeated too often.
 */
export class Vega {
  /** lines said once in the whole game (saved) */
  once = new Set<string>();
  private current: { text: string; t: number; dur: number } | null = null;
  private queue: string[] = [];
  private cool = new Map<string, number>();
  private time = 0;
  private sfx: SoundFX;

  constructor(sfx: SoundFX) { this.sfx = sfx; }

  /** `key` + once: only the first time ever; `key` + cooldown: not again for that many seconds */
  say(text: string, key?: string, opt: { once?: boolean; cooldown?: number } = {}) {
    if (key) {
      if (opt.once && this.once.has(key)) return;
      const c = this.cool.get(key);
      if (c !== undefined && this.time < c) return;
      if (opt.once) this.once.add(key);
      if (opt.cooldown) this.cool.set(key, this.time + opt.cooldown);
    }
    if (this.current?.text === text || this.queue.includes(text)) return;
    this.queue.push(text);
    if (this.queue.length > 3) this.queue.shift();
  }

  update(dt: number) {
    this.time += dt;
    const c = this.current;
    if (c) {
      c.t += dt;
      if (c.t > c.dur) this.current = null;
    }
    if (!this.current && this.queue.length) {
      const text = this.queue.shift()!;
      this.current = { text, t: 0, dur: 3 + text.length * 0.055 };
      this.sfx.play('vega');
    }
  }

  /** the line on screen: how many characters are typed so far, and its opacity */
  hud() {
    const c = this.current;
    if (!c) return null;
    return { text: c.text, chars: Math.min(c.text.length, Math.floor(c.t * 45)), alpha: c.t > c.dur - 0.7 ? Math.max(0, (c.dur - c.t) / 0.7) : 1 };
  }
}

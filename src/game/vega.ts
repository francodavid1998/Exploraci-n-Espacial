import type { SoundFX } from './sound';

/**
 * VEGA, the ship's computer: the pilot's only company. Short lines on screen (typed out,
 * then fading), a soft chime; never more than one at a time and never repeated too often.
 * The story comes first: its lines (and first-time lines) wait their turn, while repeated
 * warnings are the first to go when too many pile up. A "once" line only counts as said
 * once it was really on screen.
 * Now and then, in the deepest dark, something else speaks in VEGA's box (no chime): the
 * survivors warned about voices you know.
 */
interface Line { text: string; key?: string; once: boolean; prio: number; fake: boolean }

export class Vega {
  /** lines said once in the whole game (saved) */
  once = new Set<string>();
  private current: { text: string; t: number; dur: number; fake: boolean } | null = null;
  private queue: Line[] = [];
  private cool = new Map<string, number>();
  private time = 0;
  private sfx: SoundFX;
  /** every line that reached the screen (the map's journal) */
  onShow?: (text: string, fake: boolean) => void;
  /** replaces {KeyX} with the key or button of the device */
  format: (text: string) => string = (t) => t;

  constructor(sfx: SoundFX) { this.sfx = sfx; }

  /**
   * `key` + once: only the first time ever; `key` + cooldown: not again for that many seconds.
   * `story` lines go first and are never dropped.
   */
  say(text: string, key?: string, opt: { once?: boolean; cooldown?: number; story?: boolean } = {}) {
    const once = !!opt.once;
    if (key) {
      if (once && (this.once.has(key) || this.queue.some((q) => q.key === key))) return;
      const c = this.cool.get(key);
      if (c !== undefined && this.time < c) return;
      if (opt.cooldown) this.cool.set(key, this.time + opt.cooldown);
    }
    text = this.format(text);
    if (this.current?.text === text || this.queue.some((q) => q.text === text)) return;
    const prio = opt.story ? 2 : once ? 1 : 0;
    this.push({ text, key, once, prio, fake: false });
  }

  /** a line that is not VEGA (shown the same way, but without her chime) */
  sayFake(text: string) {
    if (this.current || this.queue.length) return false;
    this.push({ text, once: false, prio: 0, fake: true });
    return true;
  }

  private push(l: Line) {
    // by priority, in order of arrival within the same priority
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].prio < l.prio) i--;
    this.queue.splice(i, 0, l);
    // too many waiting: drop the least important (a warning that will come again)
    while (this.queue.length > 4) {
      let k = -1;
      for (let j = this.queue.length - 1; j >= 0; j--) if (this.queue[j].prio === 0) { k = j; break; }
      if (k < 0) break;
      this.queue.splice(k, 1);
    }
  }

  update(dt: number) {
    this.time += dt;
    const c = this.current;
    if (c) {
      c.t += dt;
      if (c.t > c.dur) this.current = null;
    }
    if (!this.current && this.queue.length) {
      const l = this.queue.shift()!;
      if (l.once && l.key) this.once.add(l.key);
      this.current = { text: l.text, t: 0, dur: 3 + l.text.length * 0.055, fake: l.fake };
      if (!l.fake) this.sfx.play('vega');
      this.onShow?.(l.text, l.fake);
    }
  }

  /** a line waits or is on screen */
  get busy() { return !!this.current || this.queue.length > 0; }

  /** the line on screen: how many characters are typed so far, and its opacity */
  hud() {
    const c = this.current;
    if (!c) return null;
    return { text: c.text, chars: Math.min(c.text.length, Math.floor(c.t * (c.fake ? 30 : 45))), alpha: c.t > c.dur - 0.7 ? Math.max(0, (c.dur - c.t) / 0.7) : 1, fake: c.fake };
  }
}

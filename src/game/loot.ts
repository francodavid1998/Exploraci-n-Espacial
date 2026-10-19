import * as THREE from 'three';
import type { Game } from './Game';
import { mulberry32 } from './noise';
import type { Place } from './story';

/**
 * Survival mode: things worth finding in the ruins, and what happens on the way.
 *  - Supply crates scattered in the streets of every ruined city (a faint steady light shows
 *    them at night): medkits, battery cells, oxygen cartridges, metal, a dark crystal, now
 *    and then a memento of humanity... and now and then something waiting next to them.
 *    What does not fit in the suit stays inside for later.
 *  - The shelter of each of the story's cities (the building itself belongs to the world, both
 *    modes: ruins.ts), with better supplies (the army's dispersor in Ciudad Meridiano, the
 *    seeds of the epilogue in Nueva Esperanza) and always a memento.
 *  - Travel events: distress signals (a crashed ship with supplies and guards) and void-ray
 *    ambushes in flight.
 */
type Body = Game['bodies'][number];

export type LootKind = 'medkit' | 'battery' | 'o2' | 'metal' | 'crystal' | 'memento' | 'dispersor';
/** `id`: a particular memento */
export interface LootItem { k: LootKind; n: number; id?: string }
export interface LootSpot {
  id: string;
  body: string;
  /** on the ground, relative to the body's centre */
  off: THREE.Vector3;
  kind: 'crate' | 'bunker' | 'wreck';
  items: LootItem[];
  /** opening it wakes what was waiting */
  ambush: boolean;
  /** where it is, for the notes ("Puerto Alba") */
  place: string;
  facing: THREE.Vector3;
  /** the ruined city it belongs to */
  site?: string;
}

const STORY = ['esperanza', 'alba', 'meridiano', 'telmo', 'cumbre'];

// shared looks
const M = {
  crate: new THREE.MeshStandardMaterial({ color: 0x3b4230, roughness: 0.7, metalness: 0.3 }),
  lid: new THREE.MeshStandardMaterial({ color: 0x2c3224, roughness: 0.7, metalness: 0.3 }),
  hull: new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.6, metalness: 0.45 }),
  scorch: new THREE.MeshBasicMaterial({ color: 0x050505, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
};
const GEO = {
  crate: new THREE.BoxGeometry(0.9, 0.5, 0.6).translate(0, 0.25, 0),
  // the lid hangs from its hinge (the back top edge): it turns about that edge when opened
  lid: new THREE.BoxGeometry(0.94, 0.08, 0.64).translate(0, 0.04, 0.32),
  strip: new THREE.BoxGeometry(0.5, 0.04, 0.02),
  fus: new THREE.CylinderGeometry(1.4, 1.7, 9, 12),
  wing: new THREE.BoxGeometry(5, 0.2, 2.2),
  scorch: new THREE.CircleGeometry(3.4, 16).rotateX(-Math.PI / 2),
  lamp: new THREE.SphereGeometry(0.25, 10, 8),
};

export class LootSystem {
  spots = new Map<string, LootSpot>();
  opened = new Set<string>();
  /** what is still inside a spot that was too much to carry (saved) */
  left = new Map<string, LootItem[]>();
  private g: Game;
  private sitesDone = new Set<string>();
  private meshes = new Map<string, { root: THREE.Object3D; light: THREE.MeshBasicMaterial; lid?: THREE.Object3D; openT: number; dim?: boolean }>();

  constructor(g: Game) { this.g = g; }

  /** how many supply crates a ruined city has (the same every game) */
  static crateCount(radius: number) { return 4 + Math.round(radius / 110); }

  /** the crates and shelter of a ruined city, placed the same way every game (once its buildings exist) */
  private ensureSite(siteId: string) {
    const g = this.g, ru = g.ruins.site(siteId);
    if (!ru || this.sitesDone.has(siteId) || !g.ruins.built(siteId)) return;
    this.sitesDone.add(siteId);
    const earth = g.byId.get('earth')!, R = earth.def.radius;
    const rnd = mulberry32(ru.seed * 31 + 7);
    const place = (x: number, z: number) => {
      // on the ground, and out of the buildings
      const d = ru.dir.clone().multiplyScalar(R).addScaledVector(ru.east, x).addScaledVector(ru.north, z).normalize();
      const w = d.clone().multiplyScalar(R + g.terrainH(earth, d)).add(earth.pos);
      g.ruins.collide(w, new THREE.Vector3(), 0.6);
      g.ruins.collide(w, new THREE.Vector3(), 0.6);
      const dd = w.sub(earth.pos).normalize();
      return dd.multiplyScalar(R + g.terrainH(earth, dd));
    };
    const n = LootSystem.crateCount(ru.radius);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, r = (0.15 + 0.7 * Math.sqrt(rnd())) * ru.radius;
      const items: LootItem[] = [];
      const roll = () => {
        const x = rnd();
        if (x < 0.24) items.push({ k: 'medkit', n: 1 });
        else if (x < 0.48) items.push({ k: 'battery', n: 1 });
        else if (x < 0.64) items.push({ k: 'o2', n: 1 });
        else if (x < 0.9) items.push({ k: 'metal', n: 2 + Math.floor(rnd() * 4) });
        else items.push({ k: 'crystal', n: 1 + Math.floor(rnd() * 2) });
      };
      roll();
      if (rnd() < 0.45) roll();
      if (rnd() < 0.14) items.push({ k: 'memento', n: 1 });
      const id = `crate:${siteId}:${i}`;
      this.spots.set(id, { id, body: 'earth', off: place(Math.cos(a) * r, Math.sin(a) * r), kind: 'crate', items, ambush: rnd() < 0.16, place: ru.name, facing: ru.north.clone(), site: siteId });
    }
    const bk = STORY.includes(siteId) ? g.ruins.bunker(siteId) : null;
    if (bk) {
      // Nueva Esperanza's shelter keeps a packet of sunflower seeds (the epilogue)
      const items: LootItem[] = [{ k: 'medkit', n: 1 }, { k: 'battery', n: 1 }, { k: 'metal', n: 6 }, { k: 'memento', n: 1, id: siteId === 'esperanza' ? 'm-semillas' : undefined }];
      if (siteId === 'meridiano') items.push({ k: 'dispersor', n: 1 });
      const id = `bunker:${siteId}`;
      this.spots.set(id, { id, body: 'earth', off: bk.off, kind: 'bunker', items, ambush: false, place: ru.name, facing: bk.facing, site: siteId });
    }
  }

  /** what a spot still holds */
  items(s: LootSpot) { return this.left.get(s.id) ?? s.items; }
  /** nothing left inside */
  markOpen(s: LootSpot) {
    this.opened.add(s.id);
    if (s.kind === 'bunker' && s.site) this.g.ruins.setBunkerOpen(s.site, true);
  }

  /** a crash site's spots (travel event) */
  addWreck(id: string, body: Body, dir: THREE.Vector3) {
    const g = this.g, R = body.def.radius;
    const up = dir.clone().normalize();
    const ref = Math.abs(up.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const east = new THREE.Vector3().crossVectors(ref, up).normalize(), north = new THREE.Vector3().crossVectors(east, up).normalize();
    const at = (x: number, z: number) => {
      const d = up.clone().multiplyScalar(R).addScaledVector(east, x).addScaledVector(north, z).normalize();
      return d.multiplyScalar(R + g.terrainH(body, d));
    };
    const rnd = mulberry32(id.length * 977 + Math.floor(dir.x * 1e4));
    const ids: string[] = [];
    this.spots.set(`${id}:wreck`, { id: `${id}:wreck`, body: body.def.id, off: at(0, 0), kind: 'wreck', items: [{ k: 'metal', n: 5 }, { k: 'o2', n: 1 }], ambush: false, place: body.def.name, facing: north });
    ids.push(`${id}:wreck`);
    for (let i = 0; i < 2; i++) {
      const cid = `${id}:c${i}`;
      const items: LootItem[] = [{ k: i ? 'battery' : 'medkit', n: 1 }, { k: 'crystal', n: 1 + Math.floor(rnd() * 2) }];
      if (rnd() < 0.35) items.push({ k: 'memento', n: 1 });
      this.spots.set(cid, { id: cid, body: body.def.id, off: at(7 + i * 3, (i ? 5 : -6)), kind: 'crate', items, ambush: false, place: body.def.name, facing: north });
      ids.push(cid);
    }
    return ids;
  }
  removeSpots(ids: string[]) {
    for (const id of ids) {
      const m = this.meshes.get(id);
      if (m) { this.g.scene.remove(m.root); m.light.dispose(); this.meshes.delete(id); }
      this.spots.delete(id);
      this.left.delete(id);
    }
  }

  /** world position of a spot */
  pos(s: LootSpot, out = new THREE.Vector3()) {
    return out.copy(s.off).add(this.g.byId.get(s.body)!.pos);
  }
  /** where to stand to use it (in front of a shelter's door) */
  usePos(s: LootSpot, out = new THREE.Vector3()) {
    this.pos(s, out);
    if (s.kind === 'bunker') out.addScaledVector(s.facing, 2.3);
    return out;
  }

  /** the spots close to the player (for R) */
  near(p: THREE.Vector3, range: number) {
    const out: LootSpot[] = [];
    const w = new THREE.Vector3();
    for (const s of this.spots.values()) {
      if (this.opened.has(s.id) || s.body !== this.g.nearest.def.id) continue;
      if (this.usePos(s, w).distanceTo(p) < range) out.push(s);
    }
    return out;
  }

  /** per frame: make the cities' spots once they exist, draw what is close */
  update() {
    const g = this.g, b = g.nearest, cw = g.camWorld;
    const focus = g.mode === 'ship' ? g.shipPos : g.playerPos;
    if (b.def.id === 'earth') {
      const n = g.ruins.nearest(focus, 6000);
      if (n) this.ensureSite(n.site.id);
    }
    const w = new THREE.Vector3();
    for (const s of this.spots.values()) {
      const here = s.body === b.def.id;
      // the shelters are part of the ruined city: only their door and lamp follow what happened inside
      if (s.kind === 'bunker') { if (here && this.opened.has(s.id) && s.site) g.ruins.setBunkerOpen(s.site, true); continue; }
      const d = here ? this.pos(s, w).distanceTo(focus) : Infinity;
      let m = this.meshes.get(s.id);
      if (!m && d < 900) { m = this.build(s); this.meshes.set(s.id, m); g.scene.add(m.root); }
      else if (m && d > 1200) { g.scene.remove(m.root); m.light.dispose(); this.meshes.delete(s.id); continue; }
      if (!m) continue;
      m.root.position.copy(this.pos(s, w)).sub(cw);
      const open = this.opened.has(s.id) || this.left.has(s.id);
      if (open && m.openT < 1) {
        // the lid swings back on its hinge in under half a second; the little light goes out
        m.openT = Math.min(1, m.openT + 1 / 24);
        const e = 1 - (1 - m.openT) ** 3;
        if (m.lid) m.lid.rotation.x = -1.85 * e;
      }
      // empty: its little light goes out (also when the rest is taken on a later visit)
      if (!m.dim && this.opened.has(s.id)) { m.dim = true; m.light.color.setRGB(0.03, 0.03, 0.02); }
    }
  }

  private build(s: LootSpot) {
    const g = this.g;
    const root = new THREE.Group();
    const up = s.off.clone().normalize();
    const z = s.facing.clone().projectOnPlane(up).normalize();
    root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, z), up, z));
    let light: THREE.MeshBasicMaterial;
    let lid: THREE.Object3D | undefined;
    if (s.kind === 'wreck') {
      // a ship like yours, nose in the ground, a steady orange emergency light
      const fus = new THREE.Mesh(GEO.fus, M.hull);
      fus.rotation.set(Math.PI / 2 - 0.35, 0.3, 0);
      fus.position.y = 1.3;
      const wing = new THREE.Mesh(GEO.wing, M.hull);
      wing.position.set(3.2, 0.5, 0.8);
      wing.rotation.set(0.2, 0.4, 0.5);
      light = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.42, 0.1) });
      const lamp = new THREE.Mesh(GEO.lamp, light);
      lamp.position.set(-0.8, 2.6, -2.5);
      root.add(fus, wing, lamp);
      // burnt ground around it: small patches that follow the slope
      const b = g.byId.get(s.body)!, R = b.def.radius, h0 = s.off.length();
      const x = new THREE.Vector3().crossVectors(up, z);
      for (const [px, pz] of [[0, 0], [4.5, 2], [-4, 3], [2.5, -4.5], [-3.5, -3]]) {
        const d = up.clone().multiplyScalar(R).addScaledVector(x, px).addScaledVector(z, pz).normalize();
        const p = new THREE.Mesh(GEO.scorch, M.scorch);
        p.position.set(px, R + g.terrainH(b, d) - h0 + 0.06 - (px * px + pz * pz) / (2 * R), pz);
        p.renderOrder = 1;
        root.add(p);
      }
    } else {
      root.add(new THREE.Mesh(GEO.crate, M.crate));
      const hinge = new THREE.Group();
      hinge.position.set(0, 0.5, -0.32);
      hinge.add(new THREE.Mesh(GEO.lid, M.lid));
      lid = hinge;
      // a faint steady light: findable in the dark, never blinking
      light = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.62, 0.18) });
      const strip = new THREE.Mesh(GEO.strip, light);
      strip.position.set(0, 0.42, 0.311);
      root.add(hinge, strip);
    }
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material !== M.scorch) { o.castShadow = true; o.receiveShadow = true; } });
    // opened before (another visit, a saved game): already open, no animation
    const was = this.opened.has(s.id) || this.left.has(s.id);
    if (was && lid) lid.rotation.x = -1.85;
    const dim = this.opened.has(s.id);
    if (dim) light.color.setRGB(0.03, 0.03, 0.02);
    return { root, light, lid, openT: was ? 1 : 0, dim };
  }

  dispose() {
    for (const m of this.meshes.values()) { this.g.scene.remove(m.root); m.light.dispose(); }
    this.meshes.clear();
  }
}

/** What happens on the way: distress signals with a crashed ship, ambushes of void rays. */
export class TravelEvents {
  active: { id: string; body: Body; dir: THREE.Vector3; spots: string[]; guarded: boolean; t: number } | null = null;
  private g: Game;
  private flightT = 0;
  private nextSignal = 120 + Math.random() * 150;
  private nextAmbush = 260 + Math.random() * 240;
  /** the player's own destination before a signal took the map's point (given back after) */
  private prev: { waypoint: string | null; user: boolean; target: Body | null } | null = null;
  /** what VEGA should say about it */
  onEvent?: (ev: 'signal' | 'signalGone' | 'wreck' | 'ambushSpace') => void;

  constructor(g: Game) { this.g = g; }

  update(dt: number) {
    const g = this.g, sv = g.surv!;
    const flying = g.mode === 'ship' && !g.landed && !g.warp;
    if (flying) this.flightT += dt;
    if (!this.active && flying && this.flightT > this.nextSignal) this.createSignal();
    if (flying && this.flightT > this.nextAmbush) {
      // only once the story has spoken of them, outside the air, and never after the end
      const air = g.nearest.def.atmo?.height ?? 0;
      if (sv.logsRead.has('tsio-2') && !sv.ended && g.altitude > air) {
        sv.enemies.hunterAmbush(2);
        this.onEvent?.('ambushSpace');
      }
      this.nextAmbush = this.flightT + 300 + Math.random() * 300;
    }
    const a = this.active;
    if (!a) return;
    a.t += dt;
    if (a.t > 900 || a.body.star !== g.sunBody) { this.end(true); return; }
    // the guards wake when you set foot near the wreck
    if (!a.guarded && g.mode === 'foot' && g.nearest === a.body) {
      const site = a.dir.clone().multiplyScalar(a.body.def.radius + g.terrainH(a.body, a.dir)).add(a.body.pos);
      if (site.distanceTo(g.playerPos) < 140) {
        a.guarded = true;
        if (!sv.ended) {
          const dark = g.light.intensity / 3.3 < 0.25;
          sv.enemies.ambush(dark ? 'night' : 'day', 3);
        }
        this.onEvent?.('wreck');
      }
    }
    if (a.spots.every((id) => sv.loot.opened.has(id) || sv.loot.left.has(id))) this.end(false);
  }

  private createSignal() {
    const g = this.g, sv = g.surv!;
    this.nextSignal = this.flightT + 240 + Math.random() * 240;
    // the nearest world with ground in this system
    let best: Body | null = null, bd = Infinity;
    for (const b of g.bodies) {
      if (b.def.kind !== 'rocky' || b.star !== g.sunBody || !b.terrain || b.def.radius < 100e3 || b.def.id === 'venus') continue;
      const d = g.shipPos.distanceTo(b.pos) - b.def.radius;
      if (d < bd) { bd = d; best = b; }
    }
    if (!best || bd > 2e9) return;
    // somewhere on the side facing the ship, on dry land
    const toShip = g.shipPos.clone().sub(best.pos).normalize();
    const sea = best.terrain!.gen.seaLevel;
    let dir: THREE.Vector3 | null = null;
    for (let i = 0; i < 40 && !dir; i++) {
      const d = toShip.clone().add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.9)).normalize();
      if (sea === null || g.terrainH(best, d) > sea + 5) dir = d;
    }
    if (!dir) return;
    // a name never used before (what was opened is saved: an old name would look already searched)
    const id = `event-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    this.active = { id, body: best, dir, spots: sv.loot.addWreck(id, best, dir), guarded: false, t: 0 };
    if (g.waypointUser && g.waypoint) {
      // the player chose where to go: the signal does not take the map's point
      g.note(`Señal de socorro detectada en ${best.def.name}. Está en el mapa (MISIONES)`);
    } else {
      this.prev = { waypoint: g.waypoint?.id ?? null, user: g.waypointUser, target: g.target };
      g.waypoint = { id: 'event', name: `Señal de socorro · ${best.def.name}` };
      g.waypointUser = false;
      g.target = best;
      g.note(`Señal de socorro detectada en ${best.def.name}. Marcada con ○`);
    }
    this.onEvent?.('signal');
  }

  private end(lost: boolean) {
    const g = this.g, a = this.active!;
    if (lost) { g.surv!.loot.removeSpots(a.spots); this.onEvent?.('signalGone'); }
    // (searched: what was too much to carry stays inside the wreck while it is around)
    // the destination you had before the signal comes back (unless you chose a new one meanwhile;
    // arriving at the wreck already cleared the signal's point)
    if (this.prev && (!g.waypoint || g.waypoint.id === 'event')) {
      const p = this.prev;
      g.waypoint = null;
      if (p?.waypoint && p.waypoint !== 'event') g.setWaypoint(p.waypoint, p.user);
      if (p && !p.waypoint) g.target = p.target;
    }
    this.prev = null;
    this.active = null;
  }

  /** the signal as the map lists it */
  place(): Place | null {
    const a = this.active;
    if (!a) return null;
    return { id: 'event', name: `Señal de socorro · ${a.body.def.name}`, body: a.body.def.id, world: a.body.def.name, system: a.body.star.def.name, desc: 'Una baliza automática de socorro: una nave estrellada. Quizá queden suministros… y algo vigilándolos.', optional: true };
  }

  /** the crash site, for the waypoint */
  pos(out: THREE.Vector3) {
    const a = this.active;
    if (!a) return null;
    return out.copy(a.dir).multiplyScalar(a.body.def.radius + this.g.terrainH(a.body, a.dir)).add(a.body.pos);
  }
}

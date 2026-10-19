import * as THREE from 'three';
import type { Game } from './Game';
import { mulberry32 } from './noise';

/**
 * Survival mode: things worth finding in the ruins, and what happens on the way.
 *  - Supply crates scattered in the streets of every ruined city (a faint steady light shows
 *    them at night): medkits, battery cells, oxygen cartridges, metal, a dark crystal, now
 *    and then a memento of humanity... and now and then something waiting next to them.
 *  - A shelter in each of the story's cities, with better supplies (the army's dispersor in
 *    Ciudad Meridiano) and always a memento.
 *  - Travel events: distress signals (a crashed ship with supplies and guards) and void-ray
 *    ambushes in flight.
 */
type Body = Game['bodies'][number];

export type LootKind = 'medkit' | 'battery' | 'o2' | 'metal' | 'crystal' | 'memento' | 'dispersor';
export interface LootItem { k: LootKind; n: number }
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
}

const STORY = ['esperanza', 'alba', 'meridiano', 'telmo', 'cumbre'];

// shared looks
const M = {
  crate: new THREE.MeshStandardMaterial({ color: 0x3b4230, roughness: 0.7, metalness: 0.3 }),
  lid: new THREE.MeshStandardMaterial({ color: 0x2c3224, roughness: 0.7, metalness: 0.3 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x5b5a56, roughness: 0.95, metalness: 0 }),
  door: new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.6, metalness: 0.5 }),
  hull: new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.6, metalness: 0.45 }),
  scorch: new THREE.MeshBasicMaterial({ color: 0x050505, transparent: true, opacity: 0.6, depthWrite: false }),
  off: new THREE.MeshBasicMaterial({ color: 0x050505 }),
};
const GEO = {
  crate: new THREE.BoxGeometry(0.9, 0.5, 0.6).translate(0, 0.25, 0),
  lid: new THREE.BoxGeometry(0.94, 0.08, 0.64).translate(0, 0.54, 0),
  strip: new THREE.BoxGeometry(0.5, 0.04, 0.02),
  bunker: new THREE.BoxGeometry(4, 2.6, 3.6).translate(0, 1.3, 0),
  door: new THREE.PlaneGeometry(1.1, 1.9),
  lamp: new THREE.BoxGeometry(0.35, 0.18, 0.18),
};

export class LootSystem {
  spots = new Map<string, LootSpot>();
  opened = new Set<string>();
  private g: Game;
  private sitesDone = new Set<string>();
  private meshes = new Map<string, { root: THREE.Object3D; light: THREE.MeshBasicMaterial }>();

  constructor(g: Game) { this.g = g; }

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
      g.ruins.collide(w, new THREE.Vector3());
      g.ruins.collide(w, new THREE.Vector3());
      const dd = w.sub(earth.pos).normalize();
      return dd.multiplyScalar(R + g.terrainH(earth, dd));
    };
    const n = 4 + Math.round(ru.radius / 110);
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
      this.spots.set(id, { id, body: 'earth', off: place(Math.cos(a) * r, Math.sin(a) * r), kind: 'crate', items, ambush: rnd() < 0.16, place: ru.name, facing: ru.north.clone() });
    }
    if (STORY.includes(siteId)) {
      const items: LootItem[] = [{ k: 'medkit', n: 1 }, { k: 'battery', n: 1 }, { k: 'metal', n: 6 }, { k: 'memento', n: 1 }];
      if (siteId === 'meridiano') items.push({ k: 'dispersor', n: 1 });
      const id = `bunker:${siteId}`;
      this.spots.set(id, { id, body: 'earth', off: place(58, -46), kind: 'bunker', items, ambush: false, place: ru.name, facing: ru.north.clone().negate() });
    }
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
      if (m) { this.g.scene.remove(m.root); this.meshes.delete(id); }
      this.spots.delete(id);
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
      const d = here ? this.pos(s, w).distanceTo(focus) : Infinity;
      let m = this.meshes.get(s.id);
      if (!m && d < 900) { m = this.build(s); this.meshes.set(s.id, m); g.scene.add(m.root); }
      else if (m && d > 1200) { g.scene.remove(m.root); this.meshes.delete(s.id); continue; }
      if (!m) continue;
      m.root.position.copy(this.pos(s, w)).sub(cw);
      if (this.opened.has(s.id) && !m.root.userData.open) {
        m.root.userData.open = true;
        m.light.color.setRGB(0.03, 0.03, 0.02);
        const lid = m.root.getObjectByName('lid');
        if (lid) { lid.rotation.x = -1.3; lid.position.set(0, 0.55, -0.32); }
      }
    }
  }

  private build(s: LootSpot) {
    const root = new THREE.Group();
    const up = s.off.clone().normalize();
    const z = s.facing.clone().projectOnPlane(up).normalize();
    root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, z), up, z));
    let light: THREE.MeshBasicMaterial;
    if (s.kind === 'bunker') {
      root.add(new THREE.Mesh(GEO.bunker, M.concrete));
      const door = new THREE.Mesh(GEO.door, M.door);
      door.position.set(0, 0.95, 1.81);
      light = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.85, 0.55, 0.18) });
      const lamp = new THREE.Mesh(GEO.lamp, light);
      lamp.position.set(0, 2.15, 1.86);
      root.add(door, lamp);
    } else if (s.kind === 'wreck') {
      // a ship like yours, nose in the ground, a steady orange emergency light
      const fus = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.7, 9, 12), M.hull);
      fus.rotation.set(Math.PI / 2 - 0.35, 0.3, 0);
      fus.position.y = 1.3;
      const wing = new THREE.Mesh(new THREE.BoxGeometry(5, 0.2, 2.2), M.hull);
      wing.position.set(3.2, 0.5, 0.8);
      wing.rotation.set(0.2, 0.4, 0.5);
      const scorch = new THREE.Mesh(new THREE.CircleGeometry(9, 24), M.scorch);
      scorch.rotation.x = -Math.PI / 2;
      scorch.position.y = 0.05;
      light = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.42, 0.1) });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8), light);
      lamp.position.set(-0.8, 2.6, -2.5);
      root.add(fus, wing, scorch, lamp);
    } else {
      root.add(new THREE.Mesh(GEO.crate, M.crate));
      const lid = new THREE.Mesh(GEO.lid, M.lid);
      lid.name = 'lid';
      // a faint steady light: findable in the dark, never blinking
      light = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.62, 0.18) });
      const strip = new THREE.Mesh(GEO.strip, light);
      strip.position.set(0, 0.42, 0.311);
      root.add(lid, strip);
    }
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material !== M.scorch) { o.castShadow = true; o.receiveShadow = true; } });
    return { root, light };
  }

  dispose() {
    for (const m of this.meshes.values()) this.g.scene.remove(m.root);
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
  private count = 0;
  /** what VEGA should say about it */
  onEvent?: (ev: 'signal' | 'signalGone' | 'wreck' | 'ambushSpace') => void;

  constructor(g: Game) { this.g = g; }

  update(dt: number) {
    const g = this.g, sv = g.surv!;
    const flying = g.mode === 'ship' && !g.landed && !g.warp;
    if (flying) this.flightT += dt;
    if (!this.active && flying && this.flightT > this.nextSignal) this.createSignal();
    if (flying && this.flightT > this.nextAmbush) {
      this.nextAmbush = this.flightT + 300 + Math.random() * 300;
      sv.enemies.hunterAmbush(2);
      this.onEvent?.('ambushSpace');
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
        const dark = g.light.intensity / 3.3 < 0.25;
        sv.enemies.ambush(dark ? 'night' : 'day', 3);
        this.onEvent?.('wreck');
      }
    }
    if (a.spots.every((id) => sv.loot.opened.has(id))) this.end(false);
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
    const id = `event${++this.count}`;
    this.active = { id, body: best, dir, spots: sv.loot.addWreck(id, best, dir), guarded: false, t: 0 };
    g.waypoint = { id: 'event', name: `Señal de socorro · ${best.def.name}` };
    g.target = best;
    g.note(`Señal de socorro detectada en ${best.def.name}. Marcada con ○`);
    this.onEvent?.('signal');
  }

  private end(lost: boolean) {
    const g = this.g, a = this.active!;
    if (lost) { g.surv!.loot.removeSpots(a.spots); this.onEvent?.('signalGone'); }
    if (g.waypoint?.id === 'event') g.waypoint = null;
    this.active = null;
  }

  /** the crash site, for the waypoint */
  pos(out: THREE.Vector3) {
    const a = this.active;
    if (!a) return null;
    return out.copy(a.dir).multiplyScalar(a.body.def.radius + this.g.terrainH(a.body, a.dir)).add(a.body.pos);
  }
}

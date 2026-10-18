import * as THREE from 'three';
import type { Game } from './Game';
import type { SoundFX } from './sound';
import { clamp } from './noise';
import { nightDir, tsiolkovskyDir, SITE_POINTS } from './alien';

/**
 * Survival mode, phase 3: what lives in the ruins.
 *  - Sentinels (machines): fixed towers guarding a few squares. They ignore light, wake up
 *    when someone comes within ~110 m and fire slow, dodgeable bolts.
 *  - Stalkers (creatures): only where the Sun does not shine. A few per zone (the night-side
 *    towns of Earth, the far side of the Moon, the night side of a few worlds) and, rarely,
 *    one alone in deep darkness. They creep up when you are not looking, flee from the
 *    flashlight and strike, then pull back.
 * Never many at once (at most MAX_STALKERS), only around the player, only on foot.
 * Phase 5:
 *  - Hunters: alien drones in low orbit of Proxima b and TRAPPIST-1 e. They keep pace with
 *    the ship whatever its speed (positions are ship-relative) and are fought with the
 *    ship's cannons (left click while flying).
 *  - The Guardian of the Spire (TRAPPIST-1 e): shielded while any of its three pylons
 *    stands; volleys of bolts; the creatures of the night come to its call.
 * Nothing flashes: lights ramp smoothly, hits are soft fading puffs.
 */
type Body = Game['bodies'][number];

const MAX_STALKERS = 6;
const STALKER_HP = 45, STALKER_HIT = 10;
/** sentinels are 1.5x the model: ~11 m tall machines */
const SENT_SCALE = 1.5;
const SENTINEL_HP = 120, SENTINEL_RANGE = 110, SENTINEL_BOLT = 12, SENTINEL_RATE = 2.2, SENTINEL_BOLT_SPEED = 30;
const PLAYER_BOLT = 20, PLAYER_BOLT_SPEED = 140, PLAYER_RATE = 0.32;
export const SHOT_ENERGY = 3;
const GUARDIAN_HP = 400, PYLON_HP = 60, GUARDIAN_RANGE = 420, GUARDIAN_SCALE = 3.2;
const HUNTER_HP = 60, HUNTER_BOLT = 5, HUNTER_RATE = 1.7, HUNTER_ALT = 2.5e6, MAX_HUNTERS = 3;
const CANNON = 30, CANNON_SPEED = 1500, CANNON_RATE = 0.22;

interface Zone {
  id: string;
  body: string;
  /** centre: unit direction from the body's centre */
  dir: THREE.Vector3;
  radius: number;
  stalkers: number;
}
interface SentinelDef { id: string; body: string; dir: THREE.Vector3 }

interface Stalker {
  pos: THREE.Vector3; // relative to the body's centre
  body: Body;
  hp: number;
  state: 'stalk' | 'flee' | 'retreat' | 'dying';
  t: number;
  phase: number;
  facing: THREE.Vector3;
  mesh: StalkerMesh;
  chirp: number;
  rare: boolean;
  size: number;
}
interface Sentinel {
  def: SentinelDef;
  body: Body;
  pos: THREE.Vector3; // base, relative to the body's centre
  hp: number;
  alert: number;
  fireT: number;
  yaw: number;
  dead: number; // 0 alive, >0 seconds since destroyed
  mesh: SentinelMesh;
}
interface Bolt { pos: THREE.Vector3; vel: THREE.Vector3; enemy: boolean; ttl: number; mesh: THREE.Mesh }
/** orbit fights happen in the ship's frame: rel = position minus the ship's */
interface RelBolt { rel: THREE.Vector3; vel: THREE.Vector3; enemy: boolean; ttl: number; mesh: THREE.Mesh }
interface Hunter { rel: THREE.Vector3; vel: THREE.Vector3; hp: number; fireT: number; orbit: number; mesh: THREE.Group; dying: number }
interface Guardian { hp: number; pylons: number[]; fireT: number; mesh: SentinelMesh; dead: number; shieldNote: boolean }
interface Puff { pos: THREE.Vector3; t: number; mesh: THREE.Mesh }

// ---------------------------------------------------------------------------
// Models (shared geometries and materials)
interface StalkerMesh { root: THREE.Group; legs: THREE.Group[]; eyes: THREE.MeshBasicMaterial }
interface SentinelMesh { root: THREE.Group; head: THREE.Group; eye: THREE.MeshBasicMaterial; body: THREE.Group }

const G = {
  body: new THREE.SphereGeometry(0.5, 14, 10),
  head: new THREE.SphereGeometry(0.28, 12, 8),
  eye: new THREE.SphereGeometry(0.045, 6, 4),
  leg: new THREE.CylinderGeometry(0.035, 0.015, 1.5, 5).translate(0, -0.75, 0),
  sLeg: new THREE.CylinderGeometry(0.12, 0.2, 5.6, 6).translate(0, -2.8, 0),
  sBody: new THREE.CylinderGeometry(0.55, 0.85, 1.6, 10),
  sRing: new THREE.TorusGeometry(0.95, 0.08, 6, 20),
  sHead: new THREE.CylinderGeometry(0.42, 0.5, 0.7, 8),
  sEye: new THREE.SphereGeometry(0.13, 10, 8),
  bolt: new THREE.SphereGeometry(0.11, 8, 6),
  puff: new THREE.SphereGeometry(0.3, 10, 8),
};
const skin = new THREE.MeshStandardMaterial({ color: 0x0a090b, roughness: 0.32, metalness: 0.15 });
const metal = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.42, metalness: 0.7 });
const wreck = new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.8, metalness: 0.4 });

function buildStalker(): StalkerMesh {
  const root = new THREE.Group();
  const body = new THREE.Mesh(G.body, skin);
  body.scale.set(0.55, 0.42, 1.35);
  body.position.y = 1.0;
  const head = new THREE.Mesh(G.head, skin);
  head.scale.set(0.8, 0.7, 1.25);
  head.position.set(0, 1.12, 0.92);
  // two faint pale eyes: what you see first in the dark
  const eyes = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.32, 0.36, 0.3) });
  for (const x of [-0.09, 0.09]) {
    const e = new THREE.Mesh(G.eye, eyes);
    e.position.set(x, 1.17, 1.22);
    root.add(e);
  }
  root.add(body, head);
  const legs: THREE.Group[] = [];
  for (let i = 0; i < 6; i++) {
    const side = i % 2 ? 1 : -1, row = Math.floor(i / 2);
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.22, 1.02, 0.45 - row * 0.45);
    const leg = new THREE.Mesh(G.leg, skin);
    leg.rotation.z = side * 0.95; // splayed outwards, like a spider's
    pivot.add(leg);
    root.add(pivot);
    legs.push(pivot);
  }
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return { root, legs, eyes };
}

function buildSentinel(): SentinelMesh {
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = 5.4;
  for (let i = 0; i < 3; i++) {
    const leg = new THREE.Mesh(G.sLeg, metal);
    const a = (i / 3) * Math.PI * 2;
    leg.rotation.set(Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32, 'XYZ');
    body.add(leg);
  }
  const core = new THREE.Mesh(G.sBody, metal);
  core.position.y = 0.5;
  const ring = new THREE.Mesh(G.sRing, metal);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.3;
  body.add(core, ring);
  const head = new THREE.Group();
  head.position.y = 1.65;
  const hm = new THREE.Mesh(G.sHead, metal);
  const eye = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.04, 0.02) });
  const em = new THREE.Mesh(G.sEye, eye);
  em.position.set(0, 0.05, 0.45);
  head.add(hm, em);
  body.add(head);
  root.add(body);
  root.scale.setScalar(SENT_SCALE);
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { root, head, eye, body };
}

/** a hunter drone: a dark arrowhead with three fins and a violet eye (~6 m) */
function buildHunter() {
  const root = new THREE.Group();
  const hullG = new THREE.OctahedronGeometry(1, 0);
  const hull = new THREE.Mesh(hullG, skin);
  hull.scale.set(1.3, 0.6, 3.2);
  root.add(hull);
  // dark hulls vanish against space: the fins' edges and the drive glow, steady and dim
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.32, 0.14, 0.55) });
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.6, 1.8), glow);
    fin.position.z = 1.4;
    fin.rotation.z = (i / 3) * Math.PI * 2;
    fin.position.x = Math.sin(fin.rotation.z) * -0.8;
    fin.position.y = Math.cos(fin.rotation.z) * 0.8;
    root.add(fin);
  }
  const eye = new THREE.Mesh(G.sEye, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.2, 0.9) }));
  eye.position.z = -2.9;
  eye.scale.setScalar(1.4);
  const drive = new THREE.Mesh(G.puff, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.2, 0.75), transparent: true, opacity: 0.6, depthWrite: false }));
  drive.position.z = 3.2;
  drive.scale.set(1.2, 1.2, 2);
  root.add(eye, drive);
  root.scale.setScalar(1.8);
  return root;
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
/** a quaternion standing an object on the ground (up = radial) facing `fwd` */
function standing(up: THREE.Vector3, fwd: THREE.Vector3, out: THREE.Quaternion) {
  const z = fwd.clone().addScaledVector(up, -fwd.dot(up));
  if (z.lengthSq() < 1e-8) z.set(1, 0, 0).addScaledVector(up, -up.x);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(up, z);
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, z));
}

export class EnemyDirector {
  private g: Game;
  private sfx: SoundFX;
  private zones: Zone[] = [];
  private sentinelDefs: SentinelDef[] = [];
  private stalkers: Stalker[] = [];
  private sentinels = new Map<string, Sentinel>();
  private bolts: Bolt[] = [];
  private puffs: Puff[] = [];
  /** sentinels destroyed (saved) */
  destroyed = new Set<string>();
  private spawnT = 0;
  private darkT = 0;
  private rareT = 30 + Math.random() * 60;
  private fireT = 0;
  /** the player's last hurt (0..1, fades) and what hurt them */
  hurt = 0;
  lastHit = '';
  /** seconds since the player last fired (arm pose) */
  sinceShot = 10;
  private hunters: Hunter[] = [];
  private relBolts: RelBolt[] = [];
  private hunterT = 0;
  private cannonT = 0;
  private guardian: Guardian | null = null;
  /** called once when the Guardian falls (the end of the story) */
  onGuardianDown?: () => void;
  get guardianDown() { return this.destroyed.has('guardian'); }
  private boltMats = {
    player: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.85, 1.0) }),
    enemy: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.35, 0.12) }),
  };

  constructor(g: Game, sfx: SoundFX) {
    this.g = g;
    this.sfx = sfx;
    this.placeZones();
  }

  /** Where things live. Earth's night-side towns, the dark far side of the Moon, a few night sides; machines in some squares. */
  private placeZones() {
    const g = this.g;
    const earth = g.byId.get('earth')!;
    const toSun = (b: Body) => b.star.pos.clone().sub(b.pos).normalize();
    const sunE = toSun(earth);
    for (const s of g.ruins.sites) {
      const elev = s.dir.dot(sunE);
      // only where the Sun does not shine: night and deep twilight
      if (elev < 0.05) this.zones.push({ id: s.id, body: 'earth', dir: s.dir.clone(), radius: s.radius + 350, stalkers: elev < -0.3 ? 4 : elev < -0.1 ? 3 : 2 });
    }
    // the far side of the Moon (Base Tsiolkovsky) and the night side of a few worlds: the places
    // of the signal (alien.ts puts its structures at the very same points)
    this.zones.push({ id: 'moon-far', body: 'moon', dir: tsiolkovskyDir(g), radius: 4000, stalkers: 5 });
    for (const [id, n] of [['mars', 4], ['europa', 3], ['proxima-b', 5], ['trappist-1e', 6]] as const) {
      const b = g.byId.get(id);
      if (b) this.zones.push({ id: `${id}-night`, body: id, dir: nightDir(b), radius: 3500, stalkers: n });
    }
    // sentinels: in the open square of a few ruined cities (where the recordings are)
    const towers: [string, number, number][] = [
      ['meridiano', -28, 20], ['meridiano', 27, -24], ['telmo', 30, 14], ['cumbre', -30, 18],
      ['town-6', -26, -20], ['town-6', 24, 26], ['town-1', 28, 10], ['town-9', -24, 22], ['town-15', 26, -18],
    ];
    const R = earth.def.radius;
    for (const [site, x, z] of towers) {
      const s = g.ruins.site(site);
      if (!s) continue;
      const d = s.dir.clone().multiplyScalar(R).addScaledVector(s.east, x).addScaledVector(s.north, z).normalize();
      this.sentinelDefs.push({ id: `${site}:${x}:${z}`, body: 'earth', dir: d });
    }
  }

  private surface(b: Body, dir: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(dir).multiplyScalar(b.def.radius + this.g.terrainH(b, dir));
  }

  /** the zone the player stands in, if any */
  private zoneAt(b: Body, rel: THREE.Vector3) {
    const R = b.def.radius, d = rel.clone().normalize();
    return this.zones.find((z) => z.body === b.def.id && z.dir.angleTo(d) * R < z.radius) ?? null;
  }

  // -------------------------------------------------------------------------
  update(dt: number) {
    const g = this.g;
    this.hurt = Math.max(0, this.hurt - dt * 0.9);
    this.sinceShot += dt;
    this.fireT -= dt;
    const b = g.nearest;
    const onFoot = g.mode === 'foot' && b.def.kind === 'rocky';
    const pRel = g.playerPos.clone().sub(b.pos);
    const dark = 1 - clamp(g.light.intensity / 3.3 / 0.35, 0, 1); // 1 = no sunlight at all

    // --- the player's weapon (on foot) or the ship's cannons (flying)
    if (onFoot && g.keys.has('Mouse0') && this.fireT <= 0) this.fire();
    this.updateHunters(dt);
    this.updateGuardian(dt, onFoot, pRel);

    // --- sentinels near the player (built and dropped as the player comes and goes)
    for (const def of this.sentinelDefs) {
      const sb = g.byId.get(def.body)!;
      const near = sb === b && sb.star === g.sunBody && def.dir.angleTo(pRel.clone().normalize()) * sb.def.radius < 700;
      let s = this.sentinels.get(def.id);
      if (near && !s) {
        const mesh = buildSentinel();
        g.scene.add(mesh.root);
        s = { def, body: sb, pos: this.surface(sb, def.dir), hp: SENTINEL_HP, alert: 0, fireT: 1 + Math.random(), yaw: Math.random() * 6, dead: this.destroyed.has(def.id) ? 99 : 0, mesh };
        this.sentinels.set(def.id, s);
      } else if (!near && s) {
        g.scene.remove(s.mesh.root);
        this.sentinels.delete(def.id);
      }
    }
    for (const s of this.sentinels.values()) this.updateSentinel(s, dt, onFoot, pRel);

    // --- stalkers: spawn where it is dark
    const zone = onFoot ? this.zoneAt(b, pRel) : null;
    this.darkT = onFoot && dark > 0.9 ? this.darkT + dt : 0;
    const live = this.stalkers.filter((s) => s.state !== 'dying');
    const want = zone ? Math.min(Math.round(zone.stalkers * dark), this.guardian && !this.guardian.dead ? 3 : 99) : 0;
    this.spawnT -= dt;
    if (onFoot && live.length < Math.min(want, MAX_STALKERS) && this.spawnT <= 0) {
      this.spawn(b, pRel, false);
      this.spawnT = 6 + Math.random() * 8; // they come one by one
    }
    // rare: one alone, after a while in total darkness away from every zone
    if (onFoot && !zone && this.darkT > 45) {
      this.rareT -= dt;
      if (this.rareT <= 0 && !live.some((s) => s.rare)) {
        this.spawn(b, pRel, true);
        this.rareT = 90 + Math.random() * 120;
      }
    }
    for (const s of [...this.stalkers]) this.updateStalker(s, dt, onFoot, pRel, dark, zone);

    this.updateBolts(dt);
    this.updatePuffs(dt);
  }

  private spawn(b: Body, pRel: THREE.Vector3, rare: boolean) {
    const g = this.g;
    const up = pRel.clone().normalize();
    // behind the player, outside the view, 45-80 m away
    const camF = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion).projectOnPlane(up).normalize();
    const a = Math.PI + (Math.random() - 0.5) * 2.4;
    const dir = camF.clone().applyAxisAngle(up, a);
    const p = pRel.clone().addScaledVector(dir, 45 + Math.random() * 35);
    const d = p.normalize();
    const pos = this.surface(b, d);
    const mesh = buildStalker();
    const size = 0.9 + Math.random() * 0.45;
    mesh.root.scale.setScalar(size);
    g.scene.add(mesh.root);
    this.stalkers.push({ pos, body: b, hp: STALKER_HP, state: 'stalk', t: 0, phase: Math.random() * 6, facing: dir.clone().negate(), mesh, chirp: 1 + Math.random() * 3, rare, size });
  }

  private updateStalker(s: Stalker, dt: number, onFoot: boolean, pRel: THREE.Vector3, dark: number, zone: Zone | null) {
    const g = this.g, b = s.body;
    s.t += dt;
    const remove = () => { g.scene.remove(s.mesh.root); this.stalkers.splice(this.stalkers.indexOf(s), 1); };
    if (b !== g.nearest) { remove(); return; }
    const up = s.pos.clone().normalize();
    const toP = pRel.clone().sub(s.pos);
    const dist = toP.length();
    if (s.state === 'dying') {
      // it curls up and sinks into the ground
      const k = clamp(1 - s.t / 1.3, 0, 1);
      s.mesh.root.scale.set(s.size * (0.6 + 0.4 * k), s.size * Math.max(0.05, k), s.size * (0.6 + 0.4 * k));
      if (s.t > 1.3) { remove(); return; }
      this.place(s);
      return;
    }
    // gone: the player left (boarded the ship, walked away) or the place is lit
    if (!onFoot || dist > 160 || (!zone && !s.rare) || dark < 0.25) {
      if (s.state !== 'flee') { s.state = 'flee'; s.t = 0; }
      if (s.t > 4 || dist > 160) { remove(); return; }
    }
    const camPos = g.camWorld.clone().sub(b.pos);
    const camF = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion);
    const fromCam = s.pos.clone().addScaledVector(up, 1).sub(camPos);
    const watched = fromCam.dot(camF) / fromCam.length() > Math.cos((40 * Math.PI) / 180) && dist < 50;
    // the suit's flashlight: its real beam (where the astronaut faces), ~24 m
    const lamp = pRel.clone().addScaledVector(pRel.clone().normalize(), 1.7);
    const toS = s.pos.clone().addScaledVector(up, 0.9).sub(lamp);
    const beam = g.playerFacing.clone().projectOnPlane(pRel.clone().normalize()).normalize();
    const lit = g.lightsOn && toS.length() < 24 && toS.dot(beam) / toS.length() > Math.cos((27 * Math.PI) / 180);
    if (lit && s.state === 'stalk') { s.state = 'flee'; s.t = 0; this.sfx.play('hiss', fromCam); }

    const flat = toP.clone().projectOnPlane(up);
    const toward = flat.lengthSq() > 1e-6 ? flat.normalize() : s.facing.clone();
    let speed = 0;
    let dirMove = toward;
    if (s.state === 'stalk') {
      // they creep when watched and rush when you look away
      speed = watched ? 1.1 : 5.5;
      if (dist < 2.1) {
        g.suit -= STALKER_HIT * g.surv!.mods().taken;
        this.hurt = 1;
        this.lastHit = 'stalker';
        this.sfx.play('growl', fromCam);
        this.sfx.play('hurt');
        s.state = 'retreat'; s.t = 0;
      }
    } else if (s.state === 'flee' || s.state === 'retreat') {
      speed = s.state === 'flee' ? 8 : 6;
      dirMove = toward.clone().negate();
      if (s.t > (s.state === 'flee' ? 2.8 : 1.8) && onFoot && dark > 0.25 && (zone || s.rare)) { s.state = 'stalk'; s.t = 0; }
    }
    // keep apart from each other
    for (const o of this.stalkers) {
      if (o === s) continue;
      const d = s.pos.clone().sub(o.pos);
      const l = d.length();
      if (l < 3 && l > 0.01) dirMove = dirMove.clone().addScaledVector(d.projectOnPlane(up).normalize(), (3 - l) * 0.5).normalize();
    }
    s.pos.addScaledVector(dirMove, speed * dt);
    if (b.def.id === 'earth') {
      const w = s.pos.clone().add(b.pos);
      g.ruins.collide(w, new THREE.Vector3());
      s.pos.copy(w).sub(b.pos);
    }
    this.surface(b, s.pos.clone().normalize(), s.pos);
    if (speed > 0.1) s.facing.lerp(dirMove, 1 - Math.exp(-dt * 8)).normalize();
    s.phase += dt * speed * 2.2;
    s.chirp -= dt;
    if (s.chirp <= 0 && dist < 70) {
      this.sfx.play('chitter', fromCam);
      s.chirp = 3 + Math.random() * 5;
    }
    this.place(s);
  }

  private place(s: Stalker) {
    const g = this.g, up = s.pos.clone().normalize();
    s.mesh.root.position.copy(s.body.pos).add(s.pos).sub(g.camWorld);
    standing(up, s.facing, s.mesh.root.quaternion);
    s.mesh.legs.forEach((l, i) => { l.rotation.x = Math.sin(s.phase + i * 1.7) * 0.45; });
  }

  private updateSentinel(s: Sentinel, dt: number, onFoot: boolean, pRel: THREE.Vector3) {
    const g = this.g;
    const up = s.pos.clone().normalize();
    const m = s.mesh;
    m.root.position.copy(s.body.pos).add(s.pos).sub(g.camWorld);
    if (s.dead > 0) {
      // the wreck: fallen over, dark, dead eye
      s.dead += dt;
      const f = clamp(s.dead / 1.5, 0, 1);
      standing(up, new THREE.Vector3(1, 0, 0), m.root.quaternion);
      m.body.rotation.set(f * 1.25, 0, f * 0.3);
      m.body.position.y = 5.4 - f * 3.9;
      if (!m.root.userData.wrecked) {
        m.root.userData.wrecked = true;
        m.eye.color.setRGB(0.02, 0.01, 0.01);
        m.root.traverse((o) => { if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material === metal) (o as THREE.Mesh).material = wreck; });
      }
      return;
    }
    const head = s.pos.clone().addScaledVector(up, 7.1 * SENT_SCALE);
    const toP = pRel.clone().addScaledVector(pRel.clone().normalize(), 1.2).sub(head);
    const dist = toP.length();
    const sees = onFoot && dist < SENTINEL_RANGE;
    s.alert = clamp(s.alert + (sees ? dt * 1.2 : -dt * 0.4), 0, 1);
    standing(up, new THREE.Vector3(0, 0, 1), m.root.quaternion);
    // the head scans slowly; awake, it turns to the player
    const local = toP.clone().applyQuaternion(m.root.quaternion.clone().invert());
    const want = Math.atan2(local.x, local.z);
    if (sees) {
      let d = want - s.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      s.yaw += clamp(d, -dt * 2.5, dt * 2.5);
    } else s.yaw += dt * 0.35;
    m.head.rotation.y = s.yaw;
    // the eye brightens smoothly as it wakes (never blinks)
    const comfort = g.lightsMode === 'comfort' ? 0.7 : 1;
    m.eye.color.setRGB((0.3 + 0.7 * s.alert) * comfort, (0.04 + 0.12 * s.alert) * comfort, (0.02 + 0.06 * s.alert) * comfort);
    if (s.alert > 0.05 && s.alert - dt * 1.2 <= 0.05 && sees) this.sfx.play('alert', head.clone().add(s.body.pos).sub(g.camWorld));
    s.fireT -= dt;
    if (sees && s.alert > 0.8 && s.fireT <= 0) {
      s.fireT = SENTINEL_RATE * (0.85 + Math.random() * 0.3);
      const spread = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.04 * dist);
      const v = toP.clone().add(spread).normalize().multiplyScalar(SENTINEL_BOLT_SPEED);
      this.addBolt(head.clone().add(s.body.pos), v, true);
      this.sfx.play('bolt', head.clone().add(s.body.pos).sub(g.camWorld));
    }
  }

  // -------------------------------------------------------------------------
  /** the arc rifle: a fast bolt along the view, costs battery */
  private fire() {
    const g = this.g, sv = g.surv!;
    const cost = SHOT_ENERGY * sv.mods().energy;
    if (sv.energy < cost) {
      if (g.pressed.has('Mouse0')) g.note('Batería agotada: el arma no dispara. Recárgala al sol o en la nave');
      return;
    }
    sv.energy -= cost;
    this.fireT = PLAYER_RATE;
    this.sinceShot = 0;
    const b = g.nearest;
    const up = g.playerPos.clone().sub(b.pos).normalize();
    const camF = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion);
    const right = new THREE.Vector3().crossVectors(camF, up).normalize();
    const origin = g.playerPos.clone().addScaledVector(up, 1.35).addScaledVector(right, 0.3);
    // aim where the crosshair points: the first enemy along the view ray, else 120 m ahead
    let range = 120;
    const ray = (c: THREE.Vector3, r: number) => {
      const oc = c.clone().sub(g.camWorld), tc = oc.dot(camF);
      if (tc > 0 && oc.lengthSq() - tc * tc < r * r) range = Math.min(range, tc);
    };
    for (const s of this.stalkers) if (s.state !== 'dying') ray(s.body.pos.clone().add(s.pos).addScaledVector(s.pos.clone().normalize(), 1), 0.9);
    for (const s of this.sentinels.values()) if (!s.dead) ray(s.body.pos.clone().add(s.pos).addScaledVector(s.pos.clone().normalize(), 6.2 * SENT_SCALE), 1.4 * SENT_SCALE);
    const aim = g.camWorld.clone().addScaledVector(camF, Math.max(range, 3));
    this.addBolt(origin, aim.sub(origin).normalize().multiplyScalar(PLAYER_BOLT_SPEED), false);
    this.sfx.play('shot');
  }

  private addBolt(pos: THREE.Vector3, vel: THREE.Vector3, enemy: boolean) {
    const mesh = new THREE.Mesh(G.bolt, enemy ? this.boltMats.enemy : this.boltMats.player);
    mesh.scale.set(1, 1, enemy ? 2.2 : 4);
    this.g.scene.add(mesh);
    this.bolts.push({ pos: pos.clone(), vel, enemy, ttl: enemy ? 8 : 1.6, mesh });
  }

  private updateBolts(dt: number) {
    const g = this.g, b = g.nearest;
    const glow = g.lightsMode === 'comfort' ? 0.7 : 1;
    this.boltMats.player.color.setRGB(0.35 * glow, 0.85 * glow, 1.0 * glow);
    this.boltMats.enemy.color.setRGB(1.0 * glow, 0.35 * glow, 0.12 * glow);
    for (const bo of [...this.bolts]) {
      const prev = bo.pos.clone();
      bo.pos.addScaledVector(bo.vel, dt);
      bo.ttl -= dt;
      let hit = bo.ttl <= 0;
      // ground
      const rel = bo.pos.clone().sub(b.pos);
      if (!hit && b.def.kind === 'rocky' && rel.length() < b.def.radius + g.terrainH(b, rel.clone().normalize())) hit = true;
      const seg = (c: THREE.Vector3, r: number) => {
        const ab = bo.pos.clone().sub(prev), t = clamp(c.clone().sub(prev).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
        return prev.clone().addScaledVector(ab, t).distanceTo(c) < r;
      };
      if (!hit && bo.enemy && g.mode === 'foot') {
        const chest = g.playerPos.clone().addScaledVector(g.playerPos.clone().sub(b.pos).normalize(), 1.1);
        if (seg(chest, 0.75)) {
          hit = true;
          g.suit -= SENTINEL_BOLT * g.surv!.mods().taken;
          this.hurt = 1;
          this.lastHit = this.guardian && !this.guardian.dead ? 'guardian' : 'sentinel';
          this.sfx.play('hurt');
        }
      }
      if (!hit && !bo.enemy) {
        for (const s of this.stalkers) {
          if (s.state === 'dying') continue;
          const c = s.body.pos.clone().add(s.pos).addScaledVector(s.pos.clone().normalize(), 1);
          if (seg(c, 0.9)) {
            hit = true;
            s.hp -= PLAYER_BOLT * g.surv!.mods().dealt;
            this.sfx.play('hit', c.clone().sub(g.camWorld));
            if (s.hp <= 0) {
              s.state = 'dying'; s.t = 0;
              this.sfx.play('shriek', c.clone().sub(g.camWorld));
              // what is left of it hardens into a dark crystal
              if (g.surv!.addCargo('crystal', 1)) g.note('+1 cristal oscuro: lo que queda de la criatura');
            }
            else { s.state = 'retreat'; s.t = 0; }
            break;
          }
        }
        for (const s of this.sentinels.values()) {
          if (hit || s.dead > 0) continue;
          const up = s.pos.clone().normalize();
          const c1 = s.body.pos.clone().add(s.pos).addScaledVector(up, 6.2 * SENT_SCALE);
          if (seg(c1, 1.4 * SENT_SCALE)) {
            hit = true;
            s.hp -= PLAYER_BOLT * g.surv!.mods().dealt;
            s.alert = 1;
            this.sfx.play('clank', c1.clone().sub(g.camWorld));
            if (s.hp <= 0) this.destroySentinel(s);
          }
        }
        if (!hit) hit = this.hitGuardian(seg);
      }
      if (hit) {
        this.g.scene.remove(bo.mesh);
        this.bolts.splice(this.bolts.indexOf(bo), 1);
        if (bo.ttl > 0) this.addPuff(bo.pos, bo.enemy);
        continue;
      }
      bo.mesh.position.copy(bo.pos).sub(g.camWorld);
      bo.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), bo.vel.clone().normalize());
    }
  }

  private destroySentinel(s: Sentinel) {
    const g = this.g;
    s.dead = 0.001;
    this.destroyed.add(s.def.id);
    this.sfx.play('down', s.body.pos.clone().add(s.pos).sub(g.camWorld));
    // its armour is good metal
    const sv = g.surv!;
    const got = sv.addCargo('metal', 6);
    g.note(got ? `Centinela destruido. Recuperas ${got} de metal de su blindaje` : 'Centinela destruido');
    sv.save();
  }

  /** a soft spark that grows and fades out (no flash) */
  private addPuff(pos: THREE.Vector3, enemy: boolean) {
    const mat = new THREE.MeshBasicMaterial({ color: enemy ? 0xff7a3a : 0x8fe0ff, transparent: true, opacity: 0.55, depthWrite: false });
    const mesh = new THREE.Mesh(G.puff, mat);
    this.g.scene.add(mesh);
    this.puffs.push({ pos: pos.clone(), t: 0, mesh });
  }
  private updatePuffs(dt: number) {
    for (const p of [...this.puffs]) {
      p.t += dt;
      const k = p.t / 0.5;
      if (k >= 1) {
        this.g.scene.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.puffs.splice(this.puffs.indexOf(p), 1);
        continue;
      }
      p.mesh.position.copy(p.pos).sub(this.g.camWorld);
      p.mesh.scale.setScalar(0.6 + k * 1.8);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k) * (this.g.lightsMode === 'comfort' ? 0.7 : 1);
    }
  }

  /** place everything relative to the camera (after it moved this frame) */
  render() {
    const cw = this.g.camWorld;
    for (const s of this.stalkers) this.place(s);
    for (const s of this.sentinels.values()) s.mesh.root.position.copy(s.body.pos).add(s.pos).sub(cw);
    for (const b of this.bolts) {
      b.mesh.position.copy(b.pos).sub(cw);
      b.mesh.quaternion.setFromUnitVectors(Z_AXIS, b.vel.clone().normalize());
    }
    for (const p of this.puffs) p.mesh.position.copy(p.pos).sub(cw);
    // orbit fight: the ship sits at -camOff from the camera
    const ship = this.g.camOff.clone().negate();
    if (this.g.mode !== 'ship') ship.copy(this.g.shipPos).sub(cw);
    for (const h of this.hunters) {
      h.mesh.position.copy(ship).add(h.rel);
      const look = h.vel.lengthSq() > 1 ? h.vel.clone().normalize() : h.rel.clone().negate().normalize();
      h.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), look);
    }
    for (const b of this.relBolts) {
      b.mesh.position.copy(ship).add(b.rel);
      b.mesh.quaternion.setFromUnitVectors(Z_AXIS, b.vel.clone().normalize());
    }
    if (this.guardian) {
      const s = this.g.alien.site('spire')!;
      const [gx, gz] = SITE_POINTS.spire.guardian;
      this.guardian.mesh.root.position.copy(this.g.alien.point(s, gx, gz)).sub(cw);
    }
  }

  // -------------------------------------------------------------------------
  // Orbit: the hunters of Proxima b and TRAPPIST-1 e
  private updateHunters(dt: number) {
    const g = this.g, b = g.nearest;
    const flying = g.mode === 'ship' && !g.warp && !g.landed && !g.dead;
    const zone = flying && (b.def.id === 'proxima-b' || b.def.id === 'trappist-1e') && g.altitude < HUNTER_ALT && !this.guardianDown;
    // the ship's cannons
    this.cannonT -= dt;
    if (flying && g.keys.has('Mouse0') && this.cannonT <= 0) {
      this.cannonT = CANNON_RATE;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(g.shipQ);
      for (const side of [-1, 1]) {
        const rel = new THREE.Vector3(side * 5.2, -0.3, -3).applyQuaternion(g.shipQ);
        const mesh = new THREE.Mesh(G.bolt, this.boltMats.player);
        mesh.scale.set(2, 2, 14);
        g.scene.add(mesh);
        this.relBolts.push({ rel, vel: fwd.clone().multiplyScalar(CANNON_SPEED), enemy: false, ttl: 2, mesh });
      }
      this.sfx.play('shot');
    }
    this.hunterT -= dt;
    if (zone && this.hunters.length < MAX_HUNTERS && this.hunterT <= 0) {
      this.hunterT = 4 + Math.random() * 3;
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const mesh = buildHunter();
      g.scene.add(mesh);
      this.hunters.push({ rel: d.multiplyScalar(1600), vel: new THREE.Vector3(), hp: HUNTER_HP, fireT: 2 + Math.random() * 2, orbit: Math.random() * 6, mesh, dying: 0 });
      if (this.hunters.length === 1) g.note('⚠ Contactos no identificados acercándose a la nave. Clic: cañones');
    }
    for (const h of [...this.hunters]) {
      const remove = () => { g.scene.remove(h.mesh); this.hunters.splice(this.hunters.indexOf(h), 1); };
      if (h.dying > 0) {
        h.dying += dt;
        h.mesh.scale.setScalar(1.8 * Math.max(0.05, 1 - h.dying / 0.8));
        if (h.dying > 0.8) remove();
        continue;
      }
      if (!zone) { h.rel.multiplyScalar(1 + dt * 1.5); if (h.rel.length() > 5000) remove(); continue; }
      // circle the ship at ~350 m, weaving
      h.orbit += dt * 0.35;
      const want = new THREE.Vector3(Math.cos(h.orbit), Math.sin(h.orbit * 0.7) * 0.5, Math.sin(h.orbit)).normalize().multiplyScalar(350);
      const steer = want.sub(h.rel).multiplyScalar(1.2);
      if (steer.length() > 140) steer.setLength(140);
      h.vel.lerp(steer, 1 - Math.exp(-dt * 2));
      h.rel.addScaledVector(h.vel, dt);
      h.fireT -= dt;
      if (h.fireT <= 0 && h.rel.length() < 900) {
        h.fireT = HUNTER_RATE * (0.8 + Math.random() * 0.4);
        const spread = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.06);
        const mesh = new THREE.Mesh(G.bolt, this.boltMats.enemy);
        mesh.scale.set(3, 3, 8);
        g.scene.add(mesh);
        this.relBolts.push({ rel: h.rel.clone(), vel: h.rel.clone().negate().normalize().add(spread).normalize().multiplyScalar(260), enemy: true, ttl: 5, mesh });
        this.sfx.play('bolt', h.rel.clone().sub(g.camOff));
      }
    }
    for (const bo of [...this.relBolts]) {
      const prev = bo.rel.clone();
      bo.rel.addScaledVector(bo.vel, dt);
      bo.ttl -= dt;
      let hit = bo.ttl <= 0 || g.mode !== 'ship';
      const ab = bo.rel.clone().sub(prev);
      const near = (c: THREE.Vector3, r: number) => {
        const t = clamp(c.clone().sub(prev).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
        return prev.clone().addScaledVector(ab, t).distanceTo(c) < r;
      };
      if (!hit && bo.enemy && near(new THREE.Vector3(), 8)) {
        hit = true;
        g.hull -= HUNTER_BOLT * g.surv!.mods().taken;
        this.hurt = 0.7;
        this.lastHit = 'hunter';
        this.sfx.play('hurt');
      }
      if (!hit && !bo.enemy) {
        for (const h of this.hunters) {
          if (h.dying || !near(h.rel, 7)) continue;
          hit = true;
          h.hp -= CANNON;
          this.sfx.play('clank', h.rel.clone().sub(g.camOff));
          if (h.hp <= 0) {
            h.dying = 0.001;
            this.sfx.play('down', h.rel.clone().sub(g.camOff));
            g.surv!.stored.crystal += 2;
            g.note('Cazador destruido: +2 cristales oscuros a la bodega');
          }
          break;
        }
      }
      if (hit) { g.scene.remove(bo.mesh); this.relBolts.splice(this.relBolts.indexOf(bo), 1); }
    }
  }

  // -------------------------------------------------------------------------
  // The Guardian of the Spire (TRAPPIST-1 e)
  private updateGuardian(dt: number, onFoot: boolean, pRel: THREE.Vector3) {
    const g = this.g;
    const s = g.alien.site('spire')!;
    const b = g.alien.body(s);
    const here = g.nearest === b && b.star === g.sunBody && !!b.terrain;
    const [gx, gz] = SITE_POINTS.spire.guardian;
    const gpos = here ? g.alien.point(s, gx, gz).sub(b.pos) : null;
    const dist = gpos ? gpos.distanceTo(pRel) : Infinity;
    if (!this.guardian && here && dist < 3000) {
      const mesh = buildSentinel();
      mesh.root.scale.setScalar(GUARDIAN_SCALE);
      mesh.eye.color.setRGB(0.5, 0.2, 0.9);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.12, 8, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.15, 0.6) }));
      ring.rotation.x = Math.PI / 2;
      mesh.head.add(ring);
      g.scene.add(mesh.root);
      const dead = this.guardianDown;
      this.guardian = {
        hp: dead ? 0 : GUARDIAN_HP, mesh, fireT: 3, dead: dead ? 99 : 0, shieldNote: false,
        pylons: [0, 1, 2].map((i) => (this.destroyed.has(`pylon-${i}`) || dead ? 0 : PYLON_HP)),
      };
    } else if (this.guardian && (!here || dist > 4000)) {
      g.scene.remove(this.guardian.mesh.root);
      this.guardian = null;
      return;
    }
    const gd = this.guardian;
    if (!gd || !gpos) return;
    gd.pylons.forEach((hp, i) => { if (hp <= 0) g.alien.pylonCores[i].color.setRGB(0.04, 0.02, 0.06); });
    const m = gd.mesh;
    const up = gpos.clone().normalize();
    standing(up, new THREE.Vector3(0, 0, 1), m.root.quaternion);
    if (gd.dead > 0) {
      gd.dead += dt;
      const f = clamp(gd.dead / 3, 0, 1);
      m.body.rotation.set(f * 1.1, 0, f * 0.25);
      m.body.position.y = 5.4 - f * 4;
      m.eye.color.setRGB(0.03, 0.01, 0.04);
      return;
    }
    const engaged = onFoot && dist < GUARDIAN_RANGE;
    // the head follows the player; the eye glows steadily brighter as it wakes
    const head = gpos.clone().addScaledVector(up, 7.1 * GUARDIAN_SCALE);
    const toP = pRel.clone().addScaledVector(pRel.clone().normalize(), 1.2).sub(head);
    const local = toP.clone().applyQuaternion(m.root.quaternion.clone().invert());
    m.head.rotation.y = engaged ? Math.atan2(local.x, local.z) : m.head.rotation.y + dt * 0.2;
    const k = engaged ? 1 : 0.4, c = g.lightsMode === 'comfort' ? 0.7 : 1;
    m.eye.color.setRGB(0.5 * k * c, 0.2 * k * c, 0.9 * k * c);
    gd.fireT -= dt;
    const shield = gd.pylons.some((hp) => hp > 0);
    if (engaged && gd.fireT <= 0) {
      gd.fireT = shield ? 2.6 : 1.8;
      for (let i = 0; i < 3; i++) {
        const spread = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.06 * toP.length());
        this.addBolt(head.clone().add(b.pos), toP.clone().add(spread).normalize().multiplyScalar(34), true);
      }
      this.sfx.play('bolt', head.clone().add(b.pos).sub(g.camWorld));
    }
  }

  /** a player bolt against the Guardian and its pylons (seg = the bolt's path test) */
  private hitGuardian(seg: (c: THREE.Vector3, r: number) => boolean) {
    const gd = this.guardian, g = this.g;
    if (!gd || gd.dead) return false;
    const s = g.alien.site('spire')!;
    for (let i = 0; i < 3; i++) {
      if (gd.pylons[i] <= 0) continue;
      const [px, pz] = SITE_POINTS.spire.pylons[i];
      const c = g.alien.point(s, px, pz, 16.5);
      if (!seg(c, 2.6)) continue;
      gd.pylons[i] -= PLAYER_BOLT * g.surv!.mods().dealt;
      this.sfx.play('clank', c.clone().sub(g.camWorld));
      if (gd.pylons[i] <= 0) {
        this.destroyed.add(`pylon-${i}`);
        this.sfx.play('down', c.clone().sub(g.camWorld));
        const left = gd.pylons.filter((hp) => hp > 0).length;
        g.note(left ? `Pilón destruido. Quedan ${left}` : 'El escudo del Guardián ha caído. ¡Ahora!');
        g.surv!.save();
      }
      return true;
    }
    const [gx, gz] = SITE_POINTS.spire.guardian;
    const up = g.alien.point(s, gx, gz).sub(g.alien.body(s).pos).normalize();
    const core = g.alien.point(s, gx, gz).addScaledVector(up, 6.2 * GUARDIAN_SCALE);
    if (!seg(core, 1.5 * GUARDIAN_SCALE)) return false;
    if (gd.pylons.some((hp) => hp > 0)) {
      this.sfx.play('clank', core.clone().sub(g.camWorld));
      if (!gd.shieldNote) { gd.shieldNote = true; g.note('Un escudo protege al Guardián: destruye primero los tres pilones'); }
      return true;
    }
    gd.hp -= PLAYER_BOLT * g.surv!.mods().dealt;
    this.sfx.play('hit', core.clone().sub(g.camWorld));
    if (gd.hp <= 0) {
      gd.dead = 0.001;
      this.destroyed.add('guardian');
      this.sfx.play('down', core.clone().sub(g.camWorld));
      this.onGuardianDown?.();
    }
    return true;
  }

  /** the boss bar: only while the Guardian is close */
  boss() {
    const gd = this.guardian;
    if (!gd || gd.dead) return null;
    const g = this.g, s = g.alien.site('spire')!;
    const [gx, gz] = SITE_POINTS.spire.guardian;
    if (g.alien.point(s, gx, gz).distanceTo(g.mode === 'ship' ? g.shipPos : g.playerPos) > GUARDIAN_RANGE * 1.4) return null;
    return { hp: Math.max(0, gd.hp) / GUARDIAN_HP, pylons: gd.pylons.filter((hp) => hp > 0).length };
  }

  /** how threatening things are now (0..1), for the music of fear */
  tension() {
    const g = this.g;
    let t = 0;
    const pRel = g.playerPos.clone().sub(g.nearest.pos);
    for (const s of this.stalkers) if (s.state !== 'dying') t = Math.max(t, clamp(1 - s.pos.distanceTo(pRel) / 70, 0, 1));
    for (const s of this.sentinels.values()) if (!s.dead) t = Math.max(t, s.alert * 0.8);
    if (this.hunters.length) t = Math.max(t, 0.7);
    if (this.boss()) t = 1;
    return t;
  }

  /** everything goes away (the player died, the game ended) */
  clear() {
    for (const s of this.stalkers) this.g.scene.remove(s.mesh.root);
    this.stalkers = [];
    for (const b of this.bolts) this.g.scene.remove(b.mesh);
    this.bolts = [];
    for (const h of this.hunters) this.g.scene.remove(h.mesh);
    this.hunters = [];
    for (const b of this.relBolts) this.g.scene.remove(b.mesh);
    this.relBolts = [];
    this.hurt = 0;
  }

  dispose() {
    this.clear();
    for (const s of this.sentinels.values()) this.g.scene.remove(s.mesh.root);
    this.sentinels.clear();
    if (this.guardian) this.g.scene.remove(this.guardian.mesh.root);
    this.guardian = null;
  }
}

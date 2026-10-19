import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from './Game';
import type { SoundFX } from './sound';
import { clamp } from './noise';
import { nightDir, tsiolkovskyDir, SITE_POINTS } from './alien';

/**
 * Survival mode: what lives in the ruins. Everything is alive: intimidating creatures and
 * wild beasts, never machines.
 *  - Watchers ("vigías", internally sentinels): tall rooted creatures guarding a few squares.
 *    They ignore light, wake when someone comes within ~110 m in their line of sight and spit
 *    slow, dodgeable acid.
 *  - Stalkers (creatures): only where the Sun does not shine. A few per zone (the night-side
 *    towns of Earth, the far side of the Moon, the night side of a few worlds) and, rarely,
 *    one alone in deep darkness. They creep up when you are not looking and flee from the
 *    flashlight close by, but a lamp in the dark is seen from far away: they come sooner.
 *    Before they bite they rear up hissing for a moment: there is time to dodge (Q).
 * Never many at once (at most MAX_STALKERS), only around the player, only on foot.
 * More kinds: the swarm (small, fast, many), the colossus (huge, slow, the light only slows
 * it, it charges), the spitter (keeps its distance and spits) and the trackers (wild pack
 * beasts that hunt in daylight and do not fear the lamp: daytime ruins and ambushes).
 * Phase 5:
 *  - Void rays ("mantarrayas", internally hunters): creatures of the void in low orbit of
 *    Proxima b and TRAPPIST-1 e (and ambushes anywhere in flight). They keep pace with
 *    the ship whatever its speed (positions are ship-relative) and are fought with the
 *    ship's cannons (left click while flying). Their spit flies on its own: changing speed
 *    or moving aside leaves it behind.
 *  - The Guardian of the Spire (TRAPPIST-1 e), a giant watcher: shielded while any of its
 *    three pylons stands; volleys of acid, after which it lowers its head and its heart is
 *    exposed for a moment; at two thirds and one third of its strength it calls the creatures
 *    of the night. A fallen pylon leaves a steady glow that recharges the suit.
 * Nothing flashes: lights ramp smoothly, hits are soft fading puffs.
 */
type Body = Game['bodies'][number];

const MAX_STALKERS = 6;
/** every creature together, swarms included */
const MAX_CREATURES = 10;
export type CreatureKind = 'stalker' | 'swarm' | 'colossus' | 'spitter' | 'tracker';
const KINDS: Record<CreatureKind, { hp: number; run: number; creep: number; hit: number; reach: number; size: [number, number]; light: 'flee' | 'slow' | 'ignore'; drop: number; windup: number }> = {
  stalker: { hp: 45, run: 5.5, creep: 1.1, hit: 10, reach: 2.1, size: [0.9, 1.35], light: 'flee', drop: 1, windup: 0.4 },
  swarm: { hp: 10, run: 7.5, creep: 4, hit: 4, reach: 1.3, size: [0.32, 0.45], light: 'flee', drop: 0, windup: 0.25 },
  colossus: { hp: 220, run: 3.4, creep: 2.4, hit: 25, reach: 3.6, size: [2.4, 2.8], light: 'slow', drop: 3, windup: 0.45 },
  spitter: { hp: 60, run: 4.5, creep: 3, hit: 8, reach: 0, size: [1.0, 1.2], light: 'flee', drop: 1, windup: 0.4 },
  tracker: { hp: 70, run: 8.5, creep: 6.5, hit: 12, reach: 2.5, size: [1.15, 1.45], light: 'ignore', drop: 1, windup: 0.35 },
};
/** the dispersor: a cone of pulses, strong up close */
const PELLETS = 7, PELLET_DMG = 9, PELLET_SPEED = 110, SPREAD_RATE = 0.75;
export const SPREAD_ENERGY = 6;
/** watchers are 1.5x the model: ~11 m tall */
const SENT_SCALE = 1.5;
const SENTINEL_HP = 120, SENTINEL_RANGE = 110, SENTINEL_BOLT = 12, SENTINEL_RATE = 2.2, SENTINEL_BOLT_SPEED = 30;
const PLAYER_BOLT = 20, PLAYER_BOLT_SPEED = 140, PLAYER_RATE = 0.32;
export const SHOT_ENERGY = 3;
const GUARDIAN_HP = 400, PYLON_HP = 60, GUARDIAN_RANGE = 420, GUARDIAN_SCALE = 3.2;
/** the void rays hunt below this altitude over their worlds */
export const HUNTER_ALT = 2.5e6;
const HUNTER_HP = 60, HUNTER_BOLT = 5, HUNTER_RATE = 1.7, MAX_HUNTERS = 3;
const CANNON = 30, CANNON_SPEED = 1500, CANNON_RATE = 0.22;
/** a fallen pylon's glow lasts this long (s) and recharges the suit nearby */
const PYLON_GLOW = 20;
const LEG_POOL = 96;

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
  kind: CreatureKind;
  pos: THREE.Vector3; // relative to the body's centre
  body: Body;
  hp: number;
  state: 'stalk' | 'flee' | 'retreat' | 'dying' | 'charge' | 'windup';
  /** spitting / charging cooldown */
  fireT: number;
  /** not tied to a zone (rare encounter, ambush) */
  free: boolean;
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
  /** line of sight to the player, checked a few times a second */
  sees: boolean;
  losT: number;
}
interface Bolt { pos: THREE.Vector3; vel: THREE.Vector3; enemy: boolean; ttl: number; mesh: THREE.Mesh; dmg: number; src: string }
/** orbit fights happen in the ship's frame: rel = position minus the ship's */
interface RelBolt { rel: THREE.Vector3; vel: THREE.Vector3; enemy: boolean; ttl: number; mesh: THREE.Mesh }
interface Hunter { rel: THREE.Vector3; vel: THREE.Vector3; hp: number; fireT: number; orbit: number; mesh: THREE.Group; wings: THREE.Object3D[]; dying: number }
interface Guardian {
  hp: number; pylons: number[]; fireT: number; mesh: SentinelMesh; dead: number; shieldNote: boolean;
  /** 0, then 1 below two thirds of its strength, 2 below one third */
  phase: number;
  /** seconds its heart stays exposed after a volley */
  exposed: number;
  heart: THREE.MeshBasicMaterial;
  /** the glow each fallen pylon leaves (seconds left) */
  glow: number[];
}
interface Puff { pos: THREE.Vector3; t: number; mesh: THREE.Mesh }

// ---------------------------------------------------------------------------
// Models: shared geometries and materials; the rigid parts of each kind are merged once
// (one draw instead of ten), the animated legs of every creature share one instanced mesh.
interface StalkerMesh { root: THREE.Group; legs: THREE.Object3D[]; anchors: THREE.Object3D[] }
interface SentinelMesh { root: THREE.Group; head: THREE.Group; eye: THREE.MeshBasicMaterial; body: THREE.Group }

const G = {
  body: new THREE.SphereGeometry(0.5, 14, 10),
  head: new THREE.SphereGeometry(0.28, 12, 8),
  eye: new THREE.SphereGeometry(0.045, 6, 4),
  leg: new THREE.CylinderGeometry(0.035, 0.015, 1.5, 5).translate(0, -0.75, 0),
  sLeg: new THREE.CylinderGeometry(0.12, 0.2, 5.6, 6).translate(0, -2.8, 0),
  sEye: new THREE.SphereGeometry(0.13, 10, 8),
  bolt: new THREE.SphereGeometry(0.11, 8, 6),
  puff: new THREE.SphereGeometry(0.3, 10, 8),
  jaw: new THREE.BoxGeometry(0.22, 0.08, 0.5),
  tail: new THREE.CylinderGeometry(0.05, 0.25, 4.5, 6).rotateX(Math.PI / 2),
};
/** wet dark hide: black at a distance, glistening when the lamp finds it */
const skin = new THREE.MeshStandardMaterial({ color: 0x1c1517, roughness: 0.3, metalness: 0.2 });
const spitSkin = new THREE.MeshStandardMaterial({ color: 0x0c120b, roughness: 0.28, metalness: 0.1 });
/** the hide of the rooted watchers: dark, wet, a little red */
const hide = new THREE.MeshStandardMaterial({ color: 0x26140f, roughness: 0.32, metalness: 0.15 });
const deadHide = new THREE.MeshStandardMaterial({ color: 0x0a0807, roughness: 0.85, metalness: 0 });
const SPIKE = new THREE.ConeGeometry(0.12, 0.7, 5);
/** faint eyes: what you see first in the dark (one colour per kind) */
const EYES: Record<CreatureKind, THREE.MeshBasicMaterial> = {
  stalker: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.32, 0.36, 0.3) }),
  swarm: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.32, 0.36, 0.3) }),
  colossus: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.42, 0.12, 0.08) }),
  spitter: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.22, 0.4, 0.16) }),
  tracker: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 0.32, 0.08) }),
};
const rayGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.34, 0.15, 0.6) });
const rayEye = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.2, 0.9) });

const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _t3 = new THREE.Vector3(), _tm = new THREE.Matrix4();

/** the direct child meshes of a group that share a material become one mesh */
function mergeChildren(g: THREE.Object3D) {
  const by = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const c of [...g.children]) {
    const m = c as THREE.Mesh;
    if (!m.isMesh || m.userData.keep) continue;
    m.updateMatrix();
    const geo = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k);
    const mat = m.material as THREE.Material;
    (by.get(mat) ?? by.set(mat, []).get(mat)!).push(geo);
    g.remove(m);
  }
  for (const [mat, list] of by) {
    const merged = mergeGeometries(list);
    for (const x of list) x.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (mat instanceof THREE.MeshBasicMaterial) { mesh.castShadow = false; mesh.receiveShadow = false; }
    g.add(mesh);
  }
}

const TEMPLATES = new Map<string, THREE.Group>();

/** legs: empty pivots (animated) holding an anchor with the leg's own shape; the pool draws them */
function addLeg(root: THREE.Group, x: number, y: number, z: number, rotZ: number, scale?: [number, number, number]) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  pivot.userData.leg = true;
  const anchor = new THREE.Object3D();
  anchor.rotation.z = rotZ;
  if (scale) anchor.scale.set(...scale);
  pivot.add(anchor);
  root.add(pivot);
}

/** a tracker: a long-legged predator on four legs, spines along its back, a long jaw */
function trackerTemplate() {
  const root = new THREE.Group();
  const body = new THREE.Mesh(G.body, skin);
  body.scale.set(0.62, 0.55, 1.7);
  body.position.y = 1.15;
  const head = new THREE.Mesh(G.head, skin);
  head.scale.set(0.95, 0.75, 1.9);
  head.position.set(0, 1.25, 1.15);
  const jaw = new THREE.Mesh(G.jaw, skin);
  jaw.position.set(0, 1.05, 1.35);
  jaw.rotation.x = 0.25;
  root.add(body, head, jaw);
  for (const x of [-0.11, 0.11]) {
    const e = new THREE.Mesh(G.eye, EYES.tracker);
    e.position.set(x, 1.34, 1.55);
    root.add(e);
  }
  for (let i = 0; i < 6; i++) {
    const sp = new THREE.Mesh(SPIKE, skin);
    sp.position.set(0, 1.45, 0.55 - i * 0.24);
    sp.rotation.x = -0.5;
    root.add(sp);
  }
  mergeChildren(root);
  for (let i = 0; i < 4; i++) {
    const side = i % 2 ? 1 : -1, row = Math.floor(i / 2);
    addLeg(root, side * 0.24, 1.1, 0.55 - row * 1.1, side * 0.18, [1.8, 0.75, 1.8]);
  }
  return root;
}

function creatureTemplate(kind: CreatureKind) {
  if (kind === 'tracker') return trackerTemplate();
  const root = new THREE.Group();
  const body = new THREE.Mesh(G.body, skin);
  body.scale.set(0.55, 0.42, 1.35);
  body.position.y = 1.0;
  if (kind === 'spitter') {
    // a swollen sac behind: what it spits
    const sac = new THREE.Mesh(G.body, spitSkin);
    sac.scale.set(0.75, 0.65, 0.8);
    sac.position.set(0, 1.25, -0.55);
    root.add(sac);
  }
  if (kind === 'colossus') body.scale.set(0.75, 0.6, 1.4);
  const head = new THREE.Mesh(G.head, skin);
  head.scale.set(0.8, 0.7, 1.25);
  head.position.set(0, 1.12, 0.92);
  for (const x of [-0.09, 0.09]) {
    const e = new THREE.Mesh(G.eye, EYES[kind]);
    e.position.set(x, 1.17, 1.22);
    root.add(e);
  }
  root.add(body, head);
  mergeChildren(root);
  for (let i = 0; i < 6; i++) {
    const side = i % 2 ? 1 : -1, row = Math.floor(i / 2);
    addLeg(root, side * 0.22, 1.02, 0.45 - row * 0.45, side * 0.95); // splayed outwards, like a spider's
  }
  return root;
}

function buildStalker(kind: CreatureKind = 'stalker'): StalkerMesh {
  let tpl = TEMPLATES.get(kind);
  if (!tpl) { tpl = creatureTemplate(kind); TEMPLATES.set(kind, tpl); }
  const root = tpl.clone(true);
  const legs = root.children.filter((c) => c.userData.leg);
  return { root, legs, anchors: legs.map((l) => l.children[0]) };
}

/** a watcher: three long insect legs rooted in the ground, a swollen body, a head of jaws and three eyes */
function sentinelTemplate() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.name = 'body';
  body.position.y = 5.4;
  for (let i = 0; i < 3; i++) {
    const leg = new THREE.Mesh(G.sLeg, hide);
    leg.scale.set(0.7, 1, 0.7);
    const a = (i / 3) * Math.PI * 2;
    leg.rotation.set(Math.cos(a) * 0.36, 0, Math.sin(a) * 0.36, 'XYZ');
    body.add(leg);
  }
  const core = new THREE.Mesh(G.body, hide);
  core.scale.set(1.7, 2.1, 1.7);
  core.position.y = 0.55;
  body.add(core);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const sp = new THREE.Mesh(SPIKE, hide);
    sp.scale.setScalar(1.6);
    sp.position.set(Math.cos(a) * 0.7, 1.2, Math.sin(a) * 0.7);
    sp.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6);
    body.add(sp);
  }
  mergeChildren(body);
  const head = new THREE.Group();
  head.name = 'head';
  head.position.y = 1.85;
  const hm = new THREE.Mesh(G.head, hide);
  hm.scale.set(1.9, 1.5, 2.6);
  head.add(hm);
  for (const x of [-1, 1]) {
    const mand = new THREE.Mesh(SPIKE, hide);
    mand.scale.set(1.4, 1.8, 1.4);
    mand.position.set(x * 0.28, -0.25, 0.7);
    mand.rotation.set(1.9, 0, x * 0.35);
    head.add(mand);
  }
  mergeChildren(head);
  // the eyes keep their own material (each watcher wakes on its own)
  const eyeTpl = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.04, 0.02) });
  const eyes: THREE.BufferGeometry[] = [];
  for (const [x, y] of [[-0.2, 0.12], [0.2, 0.12], [0, 0.26]]) {
    eyes.push(G.sEye.clone().scale(0.75, 0.75, 0.75).translate(x, y, 0.62));
  }
  const em = new THREE.Mesh(mergeGeometries(eyes)!, eyeTpl);
  em.name = 'eyes';
  head.add(em);
  body.add(head);
  root.add(body);
  root.scale.setScalar(SENT_SCALE);
  return root;
}
function buildSentinel(): SentinelMesh {
  let tpl = TEMPLATES.get('sentinel');
  if (!tpl) { tpl = sentinelTemplate(); TEMPLATES.set('sentinel', tpl); }
  const root = tpl.clone(true);
  const body = root.getObjectByName('body') as THREE.Group, head = root.getObjectByName('head') as THREE.Group;
  const em = root.getObjectByName('eyes') as THREE.Mesh;
  const eye = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.04, 0.02) });
  em.material = eye;
  return { root, head, eye, body };
}

/** a void ray: a creature of the vacuum, wide slow-beating wings dotted with dim violet light (~9 m) */
function hunterTemplate() {
  const root = new THREE.Group();
  const body = new THREE.Mesh(G.body, skin);
  body.scale.set(2.2, 0.5, 3.6);
  const tail = new THREE.Mesh(G.tail, skin);
  tail.position.z = 3.6;
  root.add(body, tail);
  for (const x of [-0.35, 0.35]) {
    const eye = new THREE.Mesh(G.sEye, rayEye);
    eye.position.set(x, 0.12, -1.75);
    root.add(eye);
  }
  mergeChildren(root);
  for (const x of [-1, 1]) {
    const w = new THREE.Group();
    w.userData.wing = x;
    const membrane = new THREE.Mesh(G.body, skin);
    membrane.scale.set(2.4, 0.12, 1.6);
    membrane.position.x = x * 2.1;
    w.add(membrane);
    // dark hide vanishes against space: rows of steady, dim light spots along the wings
    for (let i = 0; i < 4; i++) {
      const dot = new THREE.Mesh(G.eye, rayGlow);
      dot.scale.setScalar(3);
      dot.position.set(x * (1.2 + i * 0.75), 0.1, 0.3 - i * 0.2);
      w.add(dot);
    }
    mergeChildren(w);
    root.add(w);
  }
  root.scale.setScalar(1.6);
  return root;
}
function buildHunter() {
  let tpl = TEMPLATES.get('hunter');
  if (!tpl) { tpl = hunterTemplate(); TEMPLATES.set('hunter', tpl); }
  const root = tpl.clone(true);
  return { root, wings: root.children.filter((c) => c.userData.wing) };
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const _sz = new THREE.Vector3(), _sx = new THREE.Vector3(), _sm = new THREE.Matrix4();
/** a quaternion standing an object on the ground (up = radial) facing `fwd` */
function standing(up: THREE.Vector3, fwd: THREE.Vector3, out: THREE.Quaternion) {
  const z = _sz.copy(fwd).addScaledVector(up, -fwd.dot(up));
  if (z.lengthSq() < 1e-8) z.set(1, 0, 0).addScaledVector(up, -up.x);
  z.normalize();
  const x = _sx.crossVectors(up, z);
  return out.setFromRotationMatrix(_sm.makeBasis(x, up, z));
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
  /** watchers destroyed (saved); also the Spire's pylons and the Guardian */
  destroyed = new Set<string>();
  /** what is left of the Guardian (saved), between fights */
  guardianHp = GUARDIAN_HP;
  private pylonGlowLeft = [0, 0, 0];
  private spawnT = 0;
  private darkT = 0;
  private rareT = 30 + Math.random() * 60;
  private fireT = 0;
  /** what last hurt the player (the death screen names it) */
  lastHit = '';
  /** seconds since the player last fired (arm pose) */
  sinceShot = 10;
  private hunters: Hunter[] = [];
  /** daylight ruins: a pack of trackers once per visit */
  private dayT = 0;
  private dayPackSite = '';
  private dayPacks = new Set<string>();
  private lastZone = '';
  /** hunters coming to an ambush anywhere in space (not only near their worlds) */
  private ambushHunters = 0;
  private ambushT = 0;
  /** the last hit landed: seconds since, and what is left of the target (0..1), for the crosshair */
  hitT = 9;
  hitHp = 1;
  /** what the player has met (VEGA comments the first time) */
  onEvent?: (ev: string) => void;
  private seen = new Set<string>();
  private glob = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 0.85, 0.25) });
  /** the watchers' and the Guardian's acid: sickly yellow; the void rays' spit: violet */
  private acid = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.85, 0.7, 0.15) });
  private voidSpit = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.25, 0.9) });
  private relBolts: RelBolt[] = [];
  private hunterT = 0;
  private cannonT = 0;
  /** the ship's velocity last frame: its change leaves the spit in flight behind */
  private lastShipVel = new THREE.Vector3();
  private guardian: Guardian | null = null;
  /** called once when the Guardian falls (the end of the story) */
  onGuardianDown?: () => void;
  get guardianDown() { return this.destroyed.has('guardian'); }
  private boltMats = {
    player: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.85, 1.0) }),
    enemy: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.35, 0.12) }),
  };
  /** every creature's legs, drawn together */
  private legPool: THREE.InstancedMesh;

  constructor(g: Game, sfx: SoundFX) {
    this.g = g;
    this.sfx = sfx;
    this.placeZones();
    this.legPool = new THREE.InstancedMesh(G.leg, skin, LEG_POOL);
    this.legPool.count = 0;
    this.legPool.frustumCulled = false;
    this.legPool.castShadow = true;
    this.legPool.receiveShadow = true;
    this.legPool.visible = false;
    g.scene.add(this.legPool);
  }

  /** the player's last hurt (0..1, fades), kept by the game for both modes */
  get hurt() { return this.g.hurt; }
  /** the player stands in a dark zone where things live */
  get inZone() { return this.lastZone !== ''; }

  /** Where things live: Earth's night-side towns, the dark far side of the Moon, a few night sides; watchers in some squares. */
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
    // watchers: in the open square of a few ruined cities (where the recordings are)
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
  /** deep water: creatures of the land do not go in */
  private wet(b: Body, dir: THREE.Vector3) {
    const sea = this.g.seaLevel(b);
    return sea !== null && this.g.terrainH(b, dir) < sea - 1;
  }

  /** the zone the player stands in, if any */
  private zoneAt(b: Body, rel: THREE.Vector3) {
    const R = b.def.radius, d = rel.clone().normalize();
    return this.zones.find((z) => z.body === b.def.id && z.dir.angleTo(d) * R < z.radius) ?? null;
  }

  /** the player was hurt from `from` (world position; null: no direction) */
  private hurtPlayer(amount: number, from: THREE.Vector3 | null, src: string) {
    const g = this.g;
    g.hurt = Math.max(g.hurt, amount);
    g.hurtDir = from ? from.clone().sub(g.mode === 'ship' ? g.shipPos : g.playerPos).normalize() : null;
    this.lastHit = src;
    // the sound comes from where the blow came
    this.sfx.play('hurt', g.hurtDir ? g.hurtDir.clone().multiplyScalar(3) : undefined);
  }

  // -------------------------------------------------------------------------
  update(dt: number) {
    const g = this.g, sv = g.surv!;
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

    // --- watchers near the player (built and dropped as the player comes and goes)
    for (const def of this.sentinelDefs) {
      const sb = g.byId.get(def.body)!;
      const near = sb === b && sb.star === g.sunBody && def.dir.angleTo(_t1.copy(pRel).normalize()) * sb.def.radius < 700;
      let s = this.sentinels.get(def.id);
      if (near && !s) {
        const mesh = buildSentinel();
        g.scene.add(mesh.root);
        s = { def, body: sb, pos: this.surface(sb, def.dir), hp: SENTINEL_HP, alert: 0, fireT: 1 + Math.random(), yaw: Math.random() * 6, dead: this.destroyed.has(def.id) ? 99 : 0, mesh, sees: false, losT: 0 };
        this.sentinels.set(def.id, s);
      } else if (!near && s) {
        g.scene.remove(s.mesh.root);
        s.mesh.eye.dispose();
        this.sentinels.delete(def.id);
      }
    }
    for (const s of this.sentinels.values()) this.updateSentinel(s, dt, onFoot, pRel);

    // --- stalkers: spawn where it is dark
    const zone = onFoot ? this.zoneAt(b, pRel) : null;
    const zid = zone && dark > 0.5 ? zone.id : '';
    if (zid && zid !== this.lastZone) this.onEvent?.('zone');
    this.lastZone = zid;
    // a lamp in the dark is seen from far away: they come sooner, and one more
    const lamp = g.lightsOn && onFoot && dark > 0.5;
    if (zone && lamp) this.onEvent?.('lamp');
    this.darkT = onFoot && dark > 0.9 ? this.darkT + dt : 0;
    const live = this.stalkers.filter((s) => s.state !== 'dying');
    // after the end the nights are calmer
    const calm = sv.ended ? 0.4 : 1;
    const want = zone ? Math.min(Math.round(zone.stalkers * dark * calm) + (lamp ? 1 : 0), this.guardian && !this.guardian.dead ? 3 : 99) : 0;
    // a swarm counts as one presence in its zone
    const presences = live.filter((s) => s.kind !== 'swarm').length + (live.some((s) => s.kind === 'swarm') ? 1 : 0);
    this.spawnT -= dt * (lamp ? 1.4 : 1);
    if (onFoot && zone && presences < Math.min(want, MAX_STALKERS) && live.length < MAX_CREATURES && this.spawnT <= 0) {
      // what comes: mostly stalkers; spitters, swarms and, in the deepest dark, a colossus
      const r = Math.random();
      const colossus = !sv.ended && zone.stalkers >= 4 && !live.some((s) => s.kind === 'colossus') && r < 0.12;
      const kind: CreatureKind = colossus ? 'colossus' : r < 0.32 ? 'spitter' : r < 0.47 ? 'swarm' : 'stalker';
      if (kind === 'swarm') for (let i = 0; i < 4 + Math.floor(Math.random() * 3); i++) this.spawn(b, pRel, false, 'swarm');
      else this.spawn(b, pRel, false, kind);
      this.spawnT = 6 + Math.random() * 8; // they come one by one
    }
    // rare: one alone, after a while in total darkness away from every zone
    if (onFoot && !zone && this.darkT > 45 && !sv.ended) {
      this.rareT -= dt;
      if (this.rareT <= 0 && !live.some((s) => s.rare)) {
        this.spawn(b, pRel, true);
        this.rareT = 90 + Math.random() * 120;
      }
    }
    for (const s of [...this.stalkers]) this.updateStalker(s, dt, onFoot, pRel, dark, zone);

    this.updateDayPack(dt, onFoot, pRel, dark);
    this.hitT += dt;
    this.updateBolts(dt);
    this.updatePuffs(dt);
  }

  private spawn(b: Body, pRel: THREE.Vector3, rare: boolean, kind: CreatureKind = 'stalker', near = false) {
    const g = this.g;
    const up = pRel.clone().normalize();
    // behind the player, outside the view, 45-80 m away (an ambush: 18-30 m); never in deep water
    const camF = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion).projectOnPlane(up).normalize();
    let d: THREE.Vector3 | null = null, dir = camF;
    for (let i = 0; i < 5 && !d; i++) {
      const a = Math.PI + (Math.random() - 0.5) * (2.4 + i * 0.8);
      dir = camF.clone().applyAxisAngle(up, a);
      const p = pRel.clone().addScaledVector(dir, near ? 18 + Math.random() * 12 : 45 + Math.random() * 35).normalize();
      if (!this.wet(b, p)) d = p;
    }
    if (!d) return;
    const pos = this.surface(b, d);
    const k = KINDS[kind];
    const mesh = buildStalker(kind);
    const size = k.size[0] + Math.random() * (k.size[1] - k.size[0]);
    mesh.root.scale.setScalar(size);
    g.scene.add(mesh.root);
    this.stalkers.push({ kind, pos, body: b, hp: k.hp, state: 'stalk', fireT: 2 + Math.random() * 2, free: rare || near, t: 0, phase: Math.random() * 6, facing: dir.clone().negate(), mesh, chirp: 1 + Math.random() * 3, rare, size });
  }

  /** an ambush right here: night creatures in the dark, a pack of trackers in the light */
  ambush(what: 'night' | 'day', n: number) {
    const g = this.g, b = g.nearest;
    if (g.mode !== 'foot' || b.def.kind !== 'rocky') return;
    const pRel = g.playerPos.clone().sub(b.pos);
    if (what === 'day') { for (let i = 0; i < n; i++) this.spawn(b, pRel, false, 'tracker', true); return; }
    if (n >= 3 && Math.random() < 0.5) { for (let i = 0; i < 5; i++) this.spawn(b, pRel, false, 'swarm', true); return; }
    for (let i = 0; i < n; i++) this.spawn(b, pRel, false, Math.random() < 0.3 ? 'spitter' : 'stalker', true);
  }
  /** hunters will come for the ship wherever it flies */
  hunterAmbush(n: number) {
    // a rebuilt ship is left alone for a while (calm), even by an ambush
    if (this.g.time < this.calmUntil) return;
    this.ambushHunters = n;
    this.ambushT = 90;
    this.hunterT = 0;
  }
  private calmUntil = 0;
  /** after the ship is rebuilt: the void rays leave it alone for a while */
  calm(seconds: number) {
    this.calmUntil = this.g.time + seconds;
    this.hunterT = seconds;
    this.ambushHunters = 0;
    this.ambushT = 0;
  }

  /** daylight in a ruined city of Earth: after a while, a pack of trackers comes (once per city) */
  private updateDayPack(dt: number, onFoot: boolean, pRel: THREE.Vector3, dark: number) {
    const g = this.g, b = g.nearest, sv = g.surv!;
    if (!onFoot || b.def.id !== 'earth' || dark > 0.3) { this.dayT = 0; return; }
    const n = g.ruins.nearest(g.playerPos, 900);
    if (!n || n.dist > n.site.radius + 150 || this.dayPacks.has(n.site.id)) { this.dayT = 0; return; }
    if (this.dayPackSite !== n.site.id) { this.dayPackSite = n.site.id; this.dayT = 0; }
    this.dayT += dt;
    if (this.dayT > 30 + (n.site.seed % 20)) {
      this.dayPacks.add(n.site.id);
      // the first days only one comes, howling from afar; the packs after Meridiano's warning (and not after the end)
      const early = !sv.logsRead.has('meridiano') || sv.ended;
      const k = early ? 1 : n.site.kind === 'city' && n.site.radius > 500 ? 3 : 2;
      for (let i = 0; i < k; i++) this.spawn(b, pRel, false, 'tracker');
      for (const s of this.stalkers) if (s.kind === 'tracker') s.free = true;
      const last = this.stalkers[this.stalkers.length - 1];
      const from = last ? last.pos.clone().add(b.pos).sub(g.camWorld) : new THREE.Vector3(30, 0, 30);
      this.sfx.play('growl', from);
    }
  }

  private seeOnce(key: string) {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.onEvent?.(key);
  }
  private markHit(left: number) { this.hitT = 0; this.hitHp = clamp(left, 0, 1); }

  private updateStalker(s: Stalker, dt: number, onFoot: boolean, pRel: THREE.Vector3, dark: number, zone: Zone | null) {
    const g = this.g, b = s.body, sv = g.surv!;
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
    const k = KINDS[s.kind];
    // gone: the player left (boarded the ship, walked away) or the place is lit
    if (!onFoot || dist > 160 || (!zone && !s.free) || (dark < 0.25 && !s.free)) {
      if (s.state !== 'flee') { s.state = 'flee'; s.t = 0; }
      if (s.t > 4 || dist > 160) { remove(); return; }
    }
    const camPos = g.camWorld.clone().sub(b.pos);
    const camF = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion);
    const fromCam = s.pos.clone().addScaledVector(up, 1).sub(camPos);
    const watched = fromCam.dot(camF) / fromCam.length() > Math.cos((40 * Math.PI) / 180) && dist < 50;
    // the suit's flashlight: its real beam (where the astronaut faces), ~24 m (a little more after the end)
    const lamp = pRel.clone().addScaledVector(pRel.clone().normalize(), 1.7);
    const toS = s.pos.clone().addScaledVector(up, 0.9).sub(lamp);
    const beam = g.playerFacing.clone().projectOnPlane(pRel.clone().normalize()).normalize();
    const lit = g.lightsOn && toS.length() < (sv.ended ? 30 : 24) && toS.dot(beam) / toS.length() > Math.cos((27 * Math.PI) / 180);
    // a planted light beacon: nothing that fears the light comes within ~20 m of it
    const bc = sv.beacon;
    const nearBeacon = !!bc && bc.body === b.def.id && s.pos.distanceTo(bc.off) < 20;
    // the light drives most of them away; the colossus only slows down
    if ((lit || nearBeacon) && (s.state === 'stalk' || s.state === 'windup') && k.light === 'flee') { s.state = 'flee'; s.t = 0; this.sfx.play('hiss', fromCam); }
    if (s.kind === 'tracker' && s.state === 'flee' && onFoot && dist < 160) { s.state = 'stalk'; s.t = 0; }
    if (watched && dist < 45) this.seeOnce(`seen:${s.kind}`);

    const flat = toP.clone().projectOnPlane(up);
    const toward = flat.lengthSq() > 1e-6 ? flat.normalize() : s.facing.clone();
    let speed = 0;
    let dirMove = toward;
    s.fireT -= dt;
    const strike = () => {
      g.suit -= k.hit * sv.mods().taken;
      this.hurtPlayer(1, s.pos.clone().add(b.pos), s.kind);
      this.sfx.play('growl', fromCam);
      s.state = 'retreat'; s.t = 0;
    };
    // before it bites it stops and rears up, hissing: a moment to get away (or dodge with Q)
    const windup = () => { s.state = 'windup'; s.t = 0; this.sfx.play('hiss', fromCam); };
    if (s.state === 'stalk') {
      // they creep when watched and rush when you look away
      speed = (watched ? k.creep : k.run) * (lit && k.light === 'slow' ? 0.5 : 1);
      if (s.kind === 'spitter') {
        // keeps its distance and spits
        if (dist < 18) dirMove = toward.clone().negate();
        else if (dist < 32) { dirMove = new THREE.Vector3().crossVectors(up, toward).normalize(); speed *= 0.6; }
        if (s.fireT <= 0 && dist < 45) {
          s.fireT = 2.6 * (0.85 + Math.random() * 0.3);
          const mouth = s.pos.clone().addScaledVector(up, 1.3).add(b.pos);
          const tgt = g.playerPos.clone().addScaledVector(pRel.clone().normalize(), 1.1);
          this.addBolt(mouth, tgt.sub(mouth).normalize().multiplyScalar(20), true, k.hit, 'spitter', 'glob');
          this.sfx.play('hiss', fromCam);
        }
      } else if (s.kind === 'colossus' && dist < 14 && s.fireT <= 0) {
        s.state = 'charge'; s.t = 0; s.fireT = 6;
        this.sfx.play('growl', fromCam);
      } else if (dist < k.reach) windup();
    } else if (s.state === 'windup') {
      speed = 0;
      if (s.t >= k.windup) {
        if (dist < k.reach * 1.25) strike();
        else { s.state = 'stalk'; s.t = 0; }
      }
    } else if (s.state === 'charge') {
      speed = 9.5;
      if (dist < k.reach) strike();
      else if (s.t > 1.4) { s.state = 'retreat'; s.t = 0; }
    } else if (s.state === 'flee' || s.state === 'retreat') {
      speed = s.state === 'flee' ? 8 : s.kind === 'colossus' ? 2.5 : 6;
      dirMove = toward.clone().negate();
      const back = s.state === 'flee' ? (sv.ended ? 4.5 : 2.8) : s.kind === 'swarm' ? 0.8 : 1.8;
      if (s.t > back && onFoot && (dark > 0.25 || s.free) && (zone || s.free) && !nearBeacon) { s.state = 'stalk'; s.t = 0; }
    }
    // keep apart from each other
    for (const o of this.stalkers) {
      if (o === s) continue;
      const d = _t1.copy(s.pos).sub(o.pos);
      const l = d.length();
      const room = s.kind === 'swarm' && o.kind === 'swarm' ? 1.2 : 3 * Math.max(s.size, o.size);
      if (l < room && l > 0.01) dirMove = dirMove.clone().addScaledVector(d.projectOnPlane(up).normalize(), (room - l) * 0.5).normalize();
    }
    const before = _t2.copy(s.pos);
    s.pos.addScaledVector(dirMove, speed * dt);
    // land beasts stop at the water's edge
    if (this.wet(b, _t3.copy(s.pos).normalize())) s.pos.copy(before);
    // walls and structures stand in their way too
    const w = _t3.copy(s.pos).add(b.pos);
    if (b.def.id === 'earth') g.ruins.collide(w, _t1.set(0, 0, 0), 0.6 * s.size);
    g.alien.collide(w, _t1.set(0, 0, 0), 0.6 * s.size);
    s.pos.copy(w).sub(b.pos);
    this.surface(b, _t3.copy(s.pos).normalize(), s.pos);
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
    const g = this.g, up = _t1.copy(s.pos).normalize();
    s.mesh.root.position.copy(s.body.pos).add(s.pos).sub(g.camWorld);
    standing(up, s.facing, s.mesh.root.quaternion);
    // rearing up before a bite: the body tips back, the front legs rise
    const rear = s.state === 'windup' ? Math.min(1, s.t / 0.15) : 0;
    if (rear > 0) s.mesh.root.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(_t2.set(1, 0, 0), -0.32 * rear));
    s.mesh.legs.forEach((l, i) => { l.rotation.x = i < 2 && rear > 0 ? -1.0 * rear : Math.sin(s.phase + i * 1.7) * 0.45; });
  }

  /** the watcher sees the player only with nothing in between (a few points along the line) */
  private lineOfSight(a: THREE.Vector3, b: THREE.Vector3) {
    // a point every ~1.5 m: even a narrow wall between you hides you
    const n = Math.min(80, Math.max(6, Math.ceil(a.distanceTo(b) / 1.5)));
    for (let i = 1; i < n; i++) if (this.g.solidAt(_t3.lerpVectors(a, b, i / n))) return false;
    return true;
  }

  private updateSentinel(s: Sentinel, dt: number, onFoot: boolean, pRel: THREE.Vector3) {
    const g = this.g;
    const up = s.pos.clone().normalize();
    const m = s.mesh;
    m.root.position.copy(s.body.pos).add(s.pos).sub(g.camWorld);
    if (s.dead > 0) {
      // the carcass: fallen over, dark, dead eyes
      s.dead += dt;
      const f = clamp(s.dead / 1.5, 0, 1);
      standing(up, _t1.set(1, 0, 0), m.root.quaternion);
      m.body.rotation.set(f * 1.25, 0, f * 0.3);
      m.body.position.y = 5.4 - f * 3.9;
      if (!m.root.userData.wrecked) {
        m.root.userData.wrecked = true;
        m.eye.color.setRGB(0.02, 0.01, 0.01);
        m.root.traverse((o) => { if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material === hide) (o as THREE.Mesh).material = deadHide; });
      }
      return;
    }
    const head = s.pos.clone().addScaledVector(up, 7.1 * SENT_SCALE);
    const toP = pRel.clone().addScaledVector(pRel.clone().normalize(), 1.2).sub(head);
    const dist = toP.length();
    // it sees you only in range and with nothing in between (walls hide you)
    s.losT -= dt;
    if (s.losT <= 0) {
      s.losT = 0.2;
      s.sees = onFoot && dist < SENTINEL_RANGE && this.lineOfSight(head.clone().add(s.body.pos), g.playerPos.clone().addScaledVector(up, 1.2));
    }
    const sees = s.sees && onFoot && dist < SENTINEL_RANGE;
    s.alert = clamp(s.alert + (sees ? dt * 1.2 : -dt * 0.4), 0, 1);
    standing(up, _t1.set(0, 0, 1), m.root.quaternion);
    // the head scans slowly; awake, it turns to the player
    const local = toP.clone().applyQuaternion(m.root.quaternion.clone().invert());
    const want = Math.atan2(local.x, local.z);
    if (sees) {
      let d = want - s.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      s.yaw += clamp(d, -dt * 2.5, dt * 2.5);
    } else s.yaw += dt * 0.35;
    m.head.rotation.y = s.yaw;
    // the eyes brighten smoothly as it wakes (never blink)
    const comfort = g.lightsMode === 'comfort' ? 0.7 : 1;
    m.eye.color.setRGB((0.3 + 0.7 * s.alert) * comfort, (0.04 + 0.12 * s.alert) * comfort, (0.02 + 0.06 * s.alert) * comfort);
    // waking: a slow growl from deep inside it
    if (s.alert > 0.05 && s.alert - dt * 1.2 <= 0.05 && sees) this.sfx.play('rumble', head.clone().add(s.body.pos).sub(g.camWorld));
    s.fireT -= dt;
    if (sees && s.alert > 0.8 && s.fireT <= 0) {
      s.fireT = SENTINEL_RATE * (0.85 + Math.random() * 0.3);
      const spread = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.04 * dist);
      const v = toP.clone().add(spread).normalize().multiplyScalar(SENTINEL_BOLT_SPEED);
      this.addBolt(head.clone().add(s.body.pos), v, true, SENTINEL_BOLT, 'sentinel', 'acid');
      this.seeOnce('seen:sentinel');
      this.sfx.play('bolt', head.clone().add(s.body.pos).sub(g.camWorld));
    }
  }

  // -------------------------------------------------------------------------
  /** the arc rifle: a fast bolt along the view, costs battery */
  private fire() {
    const g = this.g, sv = g.surv!;
    const cost = (sv.weapon === 'dispersor' ? SPREAD_ENERGY : SHOT_ENERGY) * sv.mods().energy;
    if (sv.energy < cost) {
      if (g.pressed.has('Mouse0')) g.note('Batería agotada: el arma no dispara. Recárgala al sol o en la nave');
      return;
    }
    sv.energy -= cost;
    this.fireT = sv.weapon === 'dispersor' ? SPREAD_RATE : PLAYER_RATE;
    this.sinceShot = 0;
    const camF = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion);
    // from the muzzle of the weapon in the right hand
    const origin = g.muzzle(new THREE.Vector3());
    // aim where the crosshair points: the first enemy along the view ray, else 120 m ahead
    let range = 120;
    const ray = (c: THREE.Vector3, r: number) => {
      const oc = c.clone().sub(g.camWorld), tc = oc.dot(camF);
      if (tc > 0 && oc.lengthSq() - tc * tc < r * r) range = Math.min(range, tc);
    };
    for (const s of this.stalkers) if (s.state !== 'dying') ray(s.body.pos.clone().add(s.pos).addScaledVector(s.pos.clone().normalize(), 1), 0.9);
    for (const s of this.sentinels.values()) if (!s.dead) ray(s.body.pos.clone().add(s.pos).addScaledVector(s.pos.clone().normalize(), 6.2 * SENT_SCALE), 1.4 * SENT_SCALE);
    const aim = g.camWorld.clone().addScaledVector(camF, Math.max(range, 3));
    const dir = aim.sub(origin).normalize();
    const dealt = sv.mods().dealt;
    if (sv.weapon === 'dispersor') {
      // a cone of pulses: devastating close, useless far
      for (let i = 0; i < PELLETS; i++) {
        const j = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.2);
        this.addBolt(origin, dir.clone().add(j).normalize().multiplyScalar(PELLET_SPEED), false, PELLET_DMG * dealt, 'player', 'pellet');
      }
      this.sfx.play('blast');
    } else {
      this.addBolt(origin, dir.multiplyScalar(PLAYER_BOLT_SPEED), false, PLAYER_BOLT * dealt, 'player');
      this.sfx.play('shot');
    }
  }

  private addBolt(pos: THREE.Vector3, vel: THREE.Vector3, enemy: boolean, dmg = SENTINEL_BOLT, src = 'sentinel', look: 'bolt' | 'glob' | 'acid' | 'pellet' = 'bolt') {
    const mesh = new THREE.Mesh(G.bolt, look === 'glob' ? this.glob : look === 'acid' ? this.acid : enemy ? this.boltMats.enemy : this.boltMats.player);
    if (look === 'glob' || look === 'acid') mesh.scale.setScalar(look === 'acid' ? 2.2 : 1.8);
    else mesh.scale.set(1, 1, look === 'pellet' ? 2 : enemy ? 2.2 : 4);
    this.g.scene.add(mesh);
    this.bolts.push({ pos: pos.clone(), vel, enemy, ttl: look === 'pellet' ? 0.45 : enemy ? 8 : 1.6, mesh, dmg, src });
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
      // the ground (or the water)
      const rel = _t1.copy(bo.pos).sub(b.pos);
      if (!hit && b.def.kind === 'rocky' && rel.length() < b.def.radius + g.surfaceH(b, _t2.copy(rel).normalize())) hit = true;
      const seg = (c: THREE.Vector3, r: number) => {
        const ab = bo.pos.clone().sub(prev), t = clamp(c.clone().sub(prev).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
        return prev.clone().addScaledVector(ab, t).distanceTo(c) < r;
      };
      if (!hit && bo.enemy && g.mode === 'foot') {
        const chest = g.playerPos.clone().addScaledVector(g.playerPos.clone().sub(b.pos).normalize(), 1.1);
        if (seg(chest, 0.75)) {
          hit = true;
          g.suit -= bo.dmg * g.surv!.mods().taken;
          this.hurtPlayer(1, prev, bo.src);
        }
      }
      if (!hit && !bo.enemy) {
        for (const s of this.stalkers) {
          if (s.state === 'dying') continue;
          const c = s.body.pos.clone().add(s.pos).addScaledVector(s.pos.clone().normalize(), s.size);
          if (seg(c, 0.8 * s.size)) {
            hit = true;
            s.hp -= bo.dmg;
            this.markHit(s.hp / KINDS[s.kind].hp);
            this.sfx.play(s.size > 2 ? 'thud' : 'hit', c.clone().sub(g.camWorld));
            if (s.hp <= 0) {
              s.state = 'dying'; s.t = 0;
              this.sfx.play('shriek', c.clone().sub(g.camWorld));
              // what is left of it hardens into dark crystal
              const drop = KINDS[s.kind].drop;
              if (drop) g.surv!.gain('crystal', drop, 'lo que queda de la criatura');
              if (s.kind === 'colossus') this.onEvent?.('kill:colossus');
            }
            else if (s.kind !== 'colossus' && s.state !== 'windup') { s.state = 'retreat'; s.t = 0; }
            break;
          }
        }
        for (const s of this.sentinels.values()) {
          if (hit || s.dead > 0) continue;
          const up = s.pos.clone().normalize();
          const c1 = s.body.pos.clone().add(s.pos).addScaledVector(up, 6.2 * SENT_SCALE);
          if (seg(c1, 1.4 * SENT_SCALE)) {
            hit = true;
            s.hp -= bo.dmg;
            this.markHit(s.hp / SENTINEL_HP);
            s.alert = 1;
            s.sees = true;
            this.sfx.play('thud', c1.clone().sub(g.camWorld));
            if (s.hp <= 0) this.destroySentinel(s);
          }
        }
        if (!hit) hit = this.hitGuardian(seg, bo.dmg);
      }
      // walls, roofs and structures stop what hit nothing else (checked along the path: they are thin);
      // tested last, or a pylon's own stone would swallow the shots aimed at its core
      if (!hit && (g.solidAt(bo.pos) || g.solidAt(_t2.lerpVectors(prev, bo.pos, 0.5)))) hit = true;
      if (hit) {
        this.g.scene.remove(bo.mesh);
        this.bolts.splice(this.bolts.indexOf(bo), 1);
        if (bo.ttl > 0) this.addPuff(bo.pos, bo.enemy);
        continue;
      }
      bo.mesh.position.copy(bo.pos).sub(g.camWorld);
      bo.mesh.quaternion.setFromUnitVectors(Z_AXIS, _t1.copy(bo.vel).normalize());
    }
  }

  private destroySentinel(s: Sentinel) {
    const g = this.g;
    s.dead = 0.001;
    this.destroyed.add(s.def.id);
    this.sfx.play('down', s.body.pos.clone().add(s.pos).sub(g.camWorld));
    // its hardened hide holds dark crystal
    g.note('Vigía abatido');
    g.surv!.gain('crystal', 3, 'arrancados de su piel');
    g.surv!.save();
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
    const g = this.g, cw = g.camWorld;
    for (const s of this.stalkers) this.place(s);
    // every creature's legs in one instanced draw
    let n = 0;
    for (const s of this.stalkers) {
      s.mesh.root.updateMatrixWorld(true);
      for (const a of s.mesh.anchors) if (n < LEG_POOL) this.legPool.setMatrixAt(n++, _tm.copy(a.matrixWorld));
    }
    this.legPool.count = n;
    this.legPool.visible = n > 0;
    if (n) this.legPool.instanceMatrix.needsUpdate = true;
    for (const s of this.sentinels.values()) s.mesh.root.position.copy(s.body.pos).add(s.pos).sub(cw);
    for (const b of this.bolts) {
      b.mesh.position.copy(b.pos).sub(cw);
      b.mesh.quaternion.setFromUnitVectors(Z_AXIS, _t1.copy(b.vel).normalize());
    }
    for (const p of this.puffs) p.mesh.position.copy(p.pos).sub(cw);
    // orbit fight: the ship sits at -camOff from the camera
    const ship = g.camOff.clone().negate();
    if (g.mode !== 'ship') ship.copy(g.shipPos).sub(cw);
    for (const h of this.hunters) {
      h.wings.forEach((w, i) => { w.rotation.z = (i ? -1 : 1) * Math.sin(g.time * 1.6 + h.orbit) * 0.28; });
      h.mesh.position.copy(ship).add(h.rel);
      const look = h.vel.lengthSq() > 1 ? _t1.copy(h.vel).normalize() : _t1.copy(h.rel).negate().normalize();
      h.mesh.quaternion.setFromUnitVectors(_t2.set(0, 0, -1), look);
    }
    for (const b of this.relBolts) {
      b.mesh.position.copy(ship).add(b.rel);
      b.mesh.quaternion.setFromUnitVectors(Z_AXIS, _t1.copy(b.vel).normalize());
    }
    if (this.guardian) {
      const s = g.alien.site('spire')!;
      const [gx, gz] = SITE_POINTS.spire.guardian;
      this.guardian.mesh.root.position.copy(g.alien.point(s, gx, gz)).sub(cw);
    }
  }

  // -------------------------------------------------------------------------
  // Orbit: the void rays of Proxima b and TRAPPIST-1 e
  private updateHunters(dt: number) {
    const g = this.g, b = g.nearest;
    const flying = g.mode === 'ship' && !g.warp && !g.landed && !g.dead;
    this.ambushT = Math.max(0, this.ambushT - dt);
    if (this.ambushT <= 0) this.ambushHunters = 0;
    const homeZone = flying && (b.def.id === 'proxima-b' || b.def.id === 'trappist-1e') && g.altitude < HUNTER_ALT && !this.guardianDown;
    const zone = homeZone || (flying && this.ambushHunters > 0);
    // everything here flies on its own: when the ship changes speed, what is in flight stays behind
    const dv = _t1.copy(g.shipVel).sub(this.lastShipVel);
    if (dv.length() > 600) dv.setLength(600);
    this.lastShipVel.copy(g.shipVel);
    if (g.mode === 'ship' && !g.warp) for (const bo of this.relBolts) bo.vel.sub(dv);
    // the pulse engine outruns any spit
    if (g.warp) for (const bo of [...this.relBolts]) if (bo.enemy) { g.scene.remove(bo.mesh); this.relBolts.splice(this.relBolts.indexOf(bo), 1); }
    // the ship's cannons (two tubes under the wings)
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
      this.sfx.play('cannon');
    }
    this.hunterT -= dt;
    const cap = homeZone ? MAX_HUNTERS : this.ambushHunters;
    if (zone && this.hunters.filter((h) => !h.dying).length < cap && this.hunterT <= 0) {
      this.hunterT = 4 + Math.random() * 3;
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const { root, wings } = buildHunter();
      g.scene.add(root);
      this.hunters.push({ rel: d.multiplyScalar(1600), vel: new THREE.Vector3(), hp: HUNTER_HP, fireT: 2 + Math.random() * 2, orbit: Math.random() * 6, mesh: root, wings, dying: 0 });
      if (this.hunters.length === 1) { g.note('⚠ Algo vivo se acerca a la nave por el vacío. {Mouse0}: cañones'); this.onEvent?.('hunters'); }
    }
    for (const h of [...this.hunters]) {
      const remove = () => { g.scene.remove(h.mesh); this.hunters.splice(this.hunters.indexOf(h), 1); };
      if (h.dying > 0) {
        h.dying += dt;
        h.mesh.scale.setScalar(1.6 * Math.max(0.05, 1 - h.dying / 0.8));
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
        const mesh = new THREE.Mesh(G.bolt, this.voidSpit);
        mesh.scale.set(4, 4, 6);
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
        this.hurtPlayer(0.7, prev.clone().add(g.shipPos), 'hunter');
      }
      if (!hit && !bo.enemy) {
        for (const h of this.hunters) {
          if (h.dying || !near(h.rel, 7)) continue;
          hit = true;
          h.hp -= CANNON;
          this.markHit(h.hp / HUNTER_HP);
          this.sfx.play('thud', h.rel.clone().sub(g.camOff));
          if (h.hp <= 0) {
            h.dying = 0.001;
            this.sfx.play('down', h.rel.clone().sub(g.camOff));
            g.surv!.stored.crystal += 2;
            g.note('Mantarraya del vacío abatida: +2 cristales oscuros a la bodega');
            if (this.ambushHunters > 0 && !homeZone) this.ambushHunters--;
            this.markHit(0);
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
    const g = this.g, sv = g.surv!;
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
      // its heart shows through the hide: a steady violet glow in the chest
      const heart = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.38, 0.16, 0.66) });
      const hm = new THREE.Mesh(G.sEye, heart);
      hm.scale.setScalar(2.2);
      hm.position.set(0, 0.7, 0.78);
      mesh.body.add(hm);
      g.scene.add(mesh.root);
      const dead = this.guardianDown;
      const hp = dead ? 0 : clamp(this.guardianHp, 1, GUARDIAN_HP);
      this.guardian = {
        hp, mesh, fireT: 3, dead: dead ? 99 : 0, shieldNote: false, heart, exposed: 0,
        phase: hp <= GUARDIAN_HP / 3 ? 2 : hp <= (GUARDIAN_HP * 2) / 3 ? 1 : 0,
        pylons: [0, 1, 2].map((i) => (this.destroyed.has(`pylon-${i}`) || dead ? 0 : PYLON_HP)),
        glow: this.pylonGlowLeft.slice(),
      };
    } else if (this.guardian && (!here || dist > 4000)) {
      g.scene.remove(this.guardian.mesh.root);
      this.guardian.mesh.eye.dispose();
      this.guardian.heart.dispose();
      // the pylons' glow keeps its time (a quick return finds it still burning); its light goes out meanwhile
      this.pylonGlowLeft = this.guardian.glow.slice();
      for (const m of g.alien.pylonGlow) m.opacity = 0;
      this.guardian = null;
      return;
    }
    const gd = this.guardian;
    if (!gd || !gpos) return;
    // the fallen pylons: dark cores, and for a while a soft steady glow that recharges the suit
    gd.pylons.forEach((hp, i) => {
      if (hp <= 0) g.alien.pylonCores[i].color.setRGB(0.04, 0.02, 0.06);
      gd.glow[i] = Math.max(0, gd.glow[i] - dt);
      const k = Math.min(1, gd.glow[i] / 3) * Math.min(1, (PYLON_GLOW - gd.glow[i]) / 1);
      const breathe = 0.85 + 0.15 * Math.sin(g.time * 1.6);
      g.alien.pylonGlow[i].opacity = 0.16 * k * breathe * (g.lightsMode === 'comfort' ? 0.7 : 1);
      if (k > 0 && onFoot) {
        const [px, pz] = SITE_POINTS.spire.pylons[i];
        if (g.alien.point(s, px, pz).distanceTo(g.playerPos) < 9) sv.energy = Math.min(100, sv.energy + 3 * dt);
      }
    });
    const m = gd.mesh;
    const up = gpos.clone().normalize();
    standing(up, _t1.set(0, 0, 1), m.root.quaternion);
    if (gd.dead > 0) {
      gd.dead += dt;
      const f = clamp(gd.dead / 3, 0, 1);
      m.body.rotation.set(f * 1.1, 0, f * 0.25);
      m.body.position.y = 5.4 - f * 4;
      m.eye.color.setRGB(0.03, 0.01, 0.04);
      gd.heart.color.setRGB(0.03, 0.01, 0.04);
      return;
    }
    const engaged = onFoot && dist < GUARDIAN_RANGE;
    // after a volley it lowers its head: the heart is exposed for a moment (it glows a little brighter, steadily)
    gd.exposed = Math.max(0, gd.exposed - dt);
    const low = Math.min(1, gd.exposed / 0.4, (2.5 - gd.exposed) / 0.4 + 0);
    m.body.rotation.x = 0.35 * clamp(low, 0, 1);
    const hk = 0.6 + 0.4 * clamp(low, 0, 1), c = g.lightsMode === 'comfort' ? 0.7 : 1;
    gd.heart.color.setRGB(0.38 * hk * c, 0.16 * hk * c, 0.66 * hk * c);
    // the head follows the player; the eyes glow steadily brighter as it wakes
    const head = gpos.clone().addScaledVector(up, 7.1 * GUARDIAN_SCALE);
    const toP = pRel.clone().addScaledVector(pRel.clone().normalize(), 1.2).sub(head);
    const local = toP.clone().applyQuaternion(m.root.quaternion.clone().invert());
    m.head.rotation.y = engaged ? Math.atan2(local.x, local.z) : m.head.rotation.y + dt * 0.2;
    const k = engaged ? 1 : 0.4;
    m.eye.color.setRGB(0.5 * k * c, 0.2 * k * c, 0.9 * k * c);
    gd.fireT -= dt;
    const shield = gd.pylons.some((hp) => hp > 0);
    if (engaged && gd.fireT <= 0 && gd.exposed <= 0) {
      gd.fireT = shield ? 2.6 : 1.8;
      for (let i = 0; i < 3; i++) {
        const spread = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.06 * toP.length());
        this.addBolt(head.clone().add(b.pos), toP.clone().add(spread).normalize().multiplyScalar(34), true, 10, 'guardian', 'acid');
      }
      this.sfx.play('bolt', head.clone().add(b.pos).sub(g.camWorld));
      if (!shield) { gd.exposed = 2.5; gd.fireT += 2.5; this.onEvent?.('heart'); }
    }
  }

  /** a player bolt against the Guardian and its pylons (seg = the bolt's path test) */
  private hitGuardian(seg: (c: THREE.Vector3, r: number) => boolean, dmg: number) {
    const gd = this.guardian, g = this.g;
    if (!gd || gd.dead) return false;
    const s = g.alien.site('spire')!;
    for (let i = 0; i < 3; i++) {
      if (gd.pylons[i] <= 0) continue;
      const [px, pz] = SITE_POINTS.spire.pylons[i];
      const c = g.alien.point(s, px, pz, 16.5);
      if (!seg(c, 2.6)) continue;
      gd.pylons[i] -= dmg;
      this.markHit(gd.pylons[i] / PYLON_HP);
      this.sfx.play('clank', c.clone().sub(g.camWorld));
      if (gd.pylons[i] <= 0) {
        this.destroyed.add(`pylon-${i}`);
        gd.glow[i] = PYLON_GLOW;
        this.sfx.play('down', c.clone().sub(g.camWorld));
        const left = gd.pylons.filter((hp) => hp > 0).length;
        g.note(left ? `Pilón destruido. Quedan ${left}` : 'El escudo del Guardián ha caído. ¡Ahora!');
        this.onEvent?.('pylonGlow');
        g.surv!.save();
      }
      return true;
    }
    const [gx, gz] = SITE_POINTS.spire.guardian;
    const up = g.alien.point(s, gx, gz).sub(g.alien.body(s).pos).normalize();
    const core = g.alien.point(s, gx, gz).addScaledVector(up, 6.2 * GUARDIAN_SCALE);
    if (!seg(core, 1.5 * GUARDIAN_SCALE)) return false;
    if (gd.pylons.some((hp) => hp > 0)) {
      this.sfx.play('thud', core.clone().sub(g.camWorld));
      if (!gd.shieldNote) { gd.shieldNote = true; g.note('Un escudo protege al Guardián: destruye primero los tres pilones'); }
      return true;
    }
    // the exposed heart takes twice the damage
    gd.hp -= dmg * (gd.exposed > 0 ? 2 : 1);
    this.guardianHp = Math.max(0, gd.hp);
    this.markHit(gd.hp / GUARDIAN_HP);
    this.sfx.play('thud', core.clone().sub(g.camWorld));
    // at two thirds and one third of its strength it calls for help
    const pRel = g.playerPos.clone().sub(g.nearest.pos);
    if (gd.phase === 0 && gd.hp <= (GUARDIAN_HP * 2) / 3) {
      gd.phase = 1;
      for (let i = 0; i < 2; i++) this.spawn(g.nearest, pRel, true, 'spitter');
      this.onEvent?.('phase2');
    } else if (gd.phase === 1 && gd.hp <= GUARDIAN_HP / 3) {
      gd.phase = 2;
      this.spawn(g.nearest, pRel, true, 'colossus');
      this.onEvent?.('phase3');
    }
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
    return { hp: Math.max(0, gd.hp) / GUARDIAN_HP, pylons: gd.pylons.filter((hp) => hp > 0).length, exposed: gd.exposed > 0 };
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
    this.legPool.count = 0;
    for (const b of this.bolts) this.g.scene.remove(b.mesh);
    this.bolts = [];
    for (const h of this.hunters) this.g.scene.remove(h.mesh);
    this.hunters = [];
    this.ambushHunters = 0;
    for (const b of this.relBolts) this.g.scene.remove(b.mesh);
    this.relBolts = [];
    this.g.hurt = 0;
  }

  dispose() {
    this.clear();
    for (const s of this.sentinels.values()) { this.g.scene.remove(s.mesh.root); s.mesh.eye.dispose(); }
    this.sentinels.clear();
    if (this.guardian) { this.g.scene.remove(this.guardian.mesh.root); this.guardian.mesh.eye.dispose(); this.guardian.heart.dispose(); }
    this.guardian = null;
    this.g.scene.remove(this.legPool);
    this.legPool.dispose();
  }
}

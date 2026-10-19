import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from './Game';
import { css } from './Game';
import { AU } from './bodies';
import { hash3, mulberry32, Noise3, clamp } from './noise';
import {
  LOGS, BASE_LOGS, FRAGMENTS, CACHES, UPGRADES, MEMENTOS, VEGA, VEGA_LAND, VEGA_STORY, DEATH, CRAFTS, FAKE_VOICES, EPILOGUE, objectiveAt,
  type LogEntry, type Objective, type UpgradeId, type CacheDef, type Place, type Memento, type CraftId,
} from './story';
import { LootSystem, TravelEvents, type LootSpot, type LootItem } from './loot';
import { Vega } from './vega';
import { SITE_POINTS, MARS_STONES } from './alien';
import { EnemyDirector, SHOT_ENERGY, SPREAD_ENERGY } from './enemies';
import { radialTexture } from './shaders';

/**
 * Survival mode, phase 1: life support (oxygen, battery, health), ship fuel, mining
 * ice and metal on the surface of rocky worlds, a mild death penalty (you wake up in
 * the ship; what you carried stays where you fell) and saved games.
 * Phase 2: Earth in ruins, the survivors' recordings and the objective they lead to.
 * Phase 3: watchers and stalkers (enemies.ts), the arc rifle, synthesised sound (sound.ts).
 * Phase 4: Base Tsiolkovsky and the scanner, the three map fragments on alien monoliths,
 * each with its own trial (Mars: light the three dark stones; Europa: dig the inscription out
 * of the ice under Jupiter's radiation; Proxima b: stay while the scanner translates).
 * Phase 5: void rays in orbit, the Guardian of the Spire and the end; hidden caches heard by
 * the scanner; dark crystals and upgrades bought in the ship; an epilogue at Nueva Esperanza.
 * And to keep it alive: supply crates, shelters and mementos in the ruins (loot.ts), distress
 * signals and ambushes on the way, more creatures, the dispersor, a dash, medkits and light
 * beacons made aboard, and VEGA, the ship's computer, who talks to you (vega.ts).
 *
 * Realistic exploration never creates this object, so nothing here can change it.
 */
export type GameMode = 'explore' | 'survival';
export type Res = 'ice' | 'metal' | 'crystal';
export const RES_LABEL: Record<Res, string> = { ice: 'hielo', metal: 'metal', crystal: 'cristal oscuro' };
const RES_KINDS: Res[] = ['ice', 'metal', 'crystal'];
const emptyCargo = (): Cargo => ({ ice: 0, metal: 0, crystal: 0 });
/** old saves had no crystals */
const fixCargo = (c: Partial<Cargo> | undefined): Cargo => ({ ice: c?.ice ?? 0, metal: c?.metal ?? 0, crystal: c?.crystal ?? 0 });

type Body = Game['bodies'][number];
type Cargo = Record<Res, number>;

/** what the suit can carry (units; 40 with the upgrade); the ship's hold has no limit */
export const CARGO_CAP = 24;
/** survival-mode tuning (percent per second unless noted) */
const O2_RATE = 100 / 360; // a full tank lasts 6 minutes on foot
const O2_RUN = 1.3; // running breathes harder
const NO_O2_DAMAGE = 3; // health lost per second with an empty tank
const LAMP_DRAIN = 0.3; // the flashlight empties a full battery in ~5.5 minutes
const SOLAR_CHARGE = 0.4; // suit panels in full sunlight
const MINE_ENERGY = 4; // battery used by one extraction
const MINE_TIME = 1.6; // seconds holding R
const MINE_RANGE = 3.2; // metres from the deposit
const READ_RANGE = 2.4; // metres from a terminal
const THRUST_BURN = 0.08; // normal engines at full throttle (x4 with turbo)
const RESERVE_POWER = 0.3; // thrusters with an empty tank
export const JUMP_COST = 2; // lighting the pulse engine
const ICE_FUEL = 5; // fuel from one unit of ice
const METAL_HULL = 8; // hull repaired with one unit of metal
const START_FUEL = 60;
/** the dash: speed (m/s) for a short moment */
const DASH_SPEED = 24, DASH_TIME = 0.22;
/** a planted light beacon burns this long (s) */
const BEACON_TIME = 120;
/** Proxima b's inscription: seconds of translation, standing close */
const TRANSLATE_TIME = 15;

/** deposits: one chance per 50 m cell of the world's surface */
const CELL = 50;
const REACH = 5; // cells around the player that may show a deposit (±275 m)
const MAX_DEPOSITS = 128;
const SAVE_KEY = 'helios-survival-1';
const AUTOSAVE = 20; // seconds
/** Europa's inscription lies under three blocks of ice (site-local points in front of the slab) */
const EUROPA_ICE: [number, number][] = [[-0.95, 1.15], [0.95, 1.15], [0, 1.75]];

interface Deposit {
  key: string;
  kind: Res;
  body: Body;
  /** position relative to the body's centre (bodies do not move or spin) */
  off: THREE.Vector3;
  q: THREE.Quaternion;
  scale: number;
  amount: number;
}

interface Crate { body: string; off: [number, number, number]; cargo: Cargo }

export interface SurvivalSave {
  v: 1;
  saved: number;
  body: string;
  off: [number, number, number];
  q: [number, number, number, number];
  landed: boolean;
  hull: number;
  health: number;
  oxygen: number;
  energy: number;
  fuel: number;
  carried: Cargo;
  stored: Cargo;
  mined: string[];
  crate: Crate | null;
  target: string | null;
  deaths: number;
  playTime: number;
  /** recordings already heard (phase 2; missing in older saves) */
  logs?: string[];
  /** watchers destroyed (phase 3); also the Spire's pylons and the Guardian (phase 5) */
  destroyed?: string[];
  /** crates and shelters opened, mementos found, medkits carried, weapon in hand, what VEGA already said */
  loot?: string[];
  mementos?: string[];
  medkits?: number;
  weapon?: 'rifle' | 'dispersor';
  vega?: string[];
  /** phase 5: caches opened, upgrades owned, the story finished */
  caches?: string[];
  upgrades?: string[];
  ended?: boolean;
  /** saved while on foot: where the astronaut stood (what they carried is left there) */
  footOff?: [number, number, number];
  guardianHp?: number;
  /** what is still inside crates that were too much to carry */
  lootLeft?: [string, LootItem[]][];
  /** ruined towns walked into */
  visited?: string[];
  beacons?: number;
  planted?: boolean;
  lastHoldLoss?: number;
  /** trials done (Mars' stones lit) */
  marks?: string[];
}

export interface SurvivalHud {
  oxygen: number;
  energy: number;
  fuel: number;
  carried: Cargo;
  stored: Cargo;
  cap: number;
  /** extraction progress 0..1 */
  mining: number;
  /** deposit within reach ("hielo" / "metal") */
  near: string | null;
  /** distance to the things you lost, when they are on this world */
  crateDist: number | null;
  refining: string | null;
  /** a save happened in the last 2 s */
  saved: boolean;
  emergency: boolean;
  /** a recording within reach */
  nearLog: boolean;
  objective: string;
  /** distance to the objective (m), when it is in this star system */
  objectiveDist: number | null;
  /** the recording on screen (the game is paused) */
  reading: LogEntry | null;
  /** the wake-up sequence of a new game is playing */
  intro: boolean;
  /** just hurt (0..1, fades): a soft red edge on the screen */
  hurt: number;
  shotCost: number;
  sound: boolean;
  /** what R does here ("escuchar el registro", "leer la inscripción"...) */
  prompt: string | null;
  scanner: boolean;
  /** the scanner hears a hidden cache on this world: distance and bearing on screen (degrees) */
  scan: { dist: number; angle: number } | null;
  boss: { hp: number; pylons: number; exposed: boolean } | null;
  upgrades: string[];
  /** the end sequence is playing */
  ending: boolean;
  stats: { time: number; deaths: number; logs: number; logsTotal: number; caches: number; cachesTotal: number; mementos: number; mementosTotal: number };
  flying: boolean;
  hunters: boolean;
  vega: { text: string; chars: number; alpha: number; fake: boolean } | null;
  /** seconds since the last hit landed, and what is left of the target */
  hitT: number;
  hitHp: number;
  weapon: 'rifle' | 'dispersor';
  dispersor: boolean;
  medkits: number;
  mementos: number;
  mementosTotal: number;
  /** why health is going down right now ("radiación de Júpiter · −30/min") */
  healthCause: string | null;
  beacons: number;
  /** a light beacon burning here: seconds left */
  beaconLeft: number | null;
  /** Proxima b's inscription being translated (0..1) and whether the pilot is close enough */
  translate: { k: number; near: boolean } | null;
  /** what the death screen says will happen */
  deathNote: string;
}

interface Interactable { pos: THREE.Vector3; prompt: string; act: () => void }

/** How rich each world is: chance of a deposit per cell, and the share of ice among them. */
function richness(id: string): { p: number; ice: number } {
  switch (id) {
    case 'europa': case 'ganymede': case 'callisto': case 'titan': case 'triton':
    case 'trappist-1f': case 'trappist-1g': case 'trappist-1h':
      return { p: 0.1, ice: 0.85 };
    case 'mercury': case 'venus': case 'io': case 'trappist-1b': case 'trappist-1c': case 'proxima-d':
      return { p: 0.1, ice: 0.08 };
    case 'mars': return { p: 0.1, ice: 0.4 };
    case 'proxima-b': case 'trappist-1e': return { p: 0.1, ice: 0.5 };
    case 'moon': case 'phobos': case 'deimos': return { p: 0.1, ice: 0.3 };
    case 'earth': return { p: 0.08, ice: 0.2 };
    default: return { p: 0.1, ice: 0.5 };
  }
}

// Cube-sphere cells (equal-angle), independent of the terrain's own chunk grid.
function toFace(d: THREE.Vector3): [number, number, number] {
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
  let f: number, u: number, v: number;
  if (ax >= ay && ax >= az) { f = d.x > 0 ? 0 : 1; u = d.y / ax; v = d.z / ax; }
  else if (ay >= az) { f = d.y > 0 ? 2 : 3; u = d.x / ay; v = d.z / ay; }
  else { f = d.z > 0 ? 4 : 5; u = d.x / az; v = d.y / az; }
  return [f, (Math.atan(u) * 4) / Math.PI, (Math.atan(v) * 4) / Math.PI];
}
function fromFace(f: number, a: number, b: number, out: THREE.Vector3) {
  const u = Math.tan((a * Math.PI) / 4), v = Math.tan((b * Math.PI) / 4);
  if (f === 0) out.set(1, u, v); else if (f === 1) out.set(-1, u, v);
  else if (f === 2) out.set(u, 1, v); else if (f === 3) out.set(u, -1, v);
  else if (f === 4) out.set(u, v, 1); else out.set(u, v, -1);
  return out.normalize();
}

/** A cluster of pale ice crystals (~1.3 m). */
function iceGeo() {
  const rnd = mulberry32(77);
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 6; k++) {
    const h = 0.45 + rnd() * 0.85, w = 0.1 + rnd() * 0.12;
    const g = new THREE.OctahedronGeometry(1, 0);
    g.scale(w, h, w);
    g.translate(0, h * 0.75, 0);
    g.rotateZ((rnd() - 0.5) * 1.0);
    g.rotateX((rnd() - 0.5) * 1.0);
    g.translate((rnd() - 0.5) * 0.55, 0, (rnd() - 0.5) * 0.55);
    parts.push(g);
  }
  return mergeGeometries(parts)!;
}
/** A dark boulder with copper-coloured veins (~1 m). */
function oreGeo() {
  const g = new THREE.IcosahedronGeometry(0.75, 1);
  const n = new Noise3(911);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + n.noise(v.x * 2.2, v.y * 2.2, v.z * 2.2) * 0.28);
    v.y = v.y * 0.7 + 0.22;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  // one colour per triangle: rock, or a vein of native metal
  const col = new Float32Array(p.count * 3);
  for (let t = 0; t < p.count; t += 3) {
    v.set(0, 0, 0);
    for (let k = 0; k < 3; k++) v.x += p.getX(t + k), v.y += p.getY(t + k), v.z += p.getZ(t + k);
    const vein = n.noise(v.x * 1.7, v.y * 1.7, v.z * 1.7) > 0.25;
    const c = vein ? [0.72, 0.42, 0.18] : [0.2, 0.18, 0.16];
    for (let k = 0; k < 3; k++) col.set(c, (t + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** sunflowers by the beacon of Nueva Esperanza (the epilogue) */
function sunflowers() {
  const root = new THREE.Group();
  const stem = new THREE.MeshStandardMaterial({ color: 0x35602a, roughness: 0.8 });
  const petal = new THREE.MeshStandardMaterial({ color: 0xe6b422, roughness: 0.7, side: THREE.DoubleSide });
  const seed = new THREE.MeshStandardMaterial({ color: 0x3b2614, roughness: 0.9 });
  const rnd = mulberry32(4242);
  for (let i = 0; i < 9; i++) {
    const f = new THREE.Group();
    const h = 0.5 + rnd() * 0.5;
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, h, 5).translate(0, h / 2, 0), stem);
    const head = new THREE.Group();
    head.position.y = h;
    head.add(new THREE.Mesh(new THREE.CircleGeometry(0.09, 14), petal), new THREE.Mesh(new THREE.CircleGeometry(0.045, 10).translate(0, 0, 0.002), seed));
    head.rotation.x = -0.5;
    f.add(s, head);
    f.position.set((rnd() - 0.5) * 1.8, 0, (rnd() - 0.5) * 1.2);
    f.rotation.y = (rnd() - 0.5) * 0.6;
    root.add(f);
  }
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return root;
}

export class Survival {
  oxygen = 100;
  energy = 100;
  fuel = START_FUEL;
  carried: Cargo = emptyCargo();
  stored: Cargo = emptyCargo();
  /** phase 5 */
  cachesOpen = new Set<string>();
  upgrades = new Set<UpgradeId>();
  ended = false;
  /** the end sequence on screen */
  ending = false;
  /** the epilogue: the sunflowers are planted */
  planted = false;
  /** survival kit and finds */
  medkits = 1;
  beacons = 0;
  /** a light beacon planted in the ground (relative to its world's centre) */
  beacon: { body: string; off: THREE.Vector3; t: number } | null = null;
  weapon: 'rifle' | 'dispersor' = 'rifle';
  mementos = new Set<string>();
  /** ruined towns walked into */
  visited = new Set<string>();
  loot: LootSystem;
  events: TravelEvents;
  vega: Vega;
  /** last time something moved the game forward (VEGA reminds you of the map after a while) */
  private lastProgress = 0;
  mined = new Set<string>();
  crate: Crate | null = null;
  deaths = 0;
  playTime = 0;
  /** jumping on the reserve towards the nearest world: no fuel burnt, autopilot on */
  emergency = false;
  /** recordings heard, and the one on screen (pauses the game) */
  logsRead = new Set<string>();
  reading: LogEntry | null = null;
  /** a new game opens with the ship's computer waking the pilot */
  intro = false;
  /** the trials of the fragments: Mars' stones lit (saved), Proxima's translation under way */
  marks = new Set<string>();
  private marsT = [0, 0, 0];
  private translate: { t: number } | null = null;
  /** Earth's ruins belong to the world (both modes); survival places its recordings in them */
  private get ruins() { return this.g.ruins; }
  /** the game's sound (both modes share it) */
  get sfx() { return this.g.sfx; }
  enemies: EnemyDirector;

  private g: Game;
  private deposits: Deposit[] = [];
  private fieldKey = '';
  private mineProgress = 0;
  private mineTarget: Deposit | null = null;
  private nearDeposit: Deposit | null = null;
  private refineT = 0;
  private refining: string | null = null;
  private saveT = 0;
  private savedAt = -10;
  private wasFoot = false;
  private meshes: Record<Res, THREE.InstancedMesh>;
  private crateMesh: THREE.Group;
  private crateMarker: HTMLDivElement;
  private crateArrow: HTMLDivElement;
  private crateLabel: HTMLDivElement;
  private crateDist: number | null = null;
  private objMarker: HTMLDivElement;
  private objArrow: HTMLDivElement;
  private objLabel: HTMLDivElement;
  private objDist: number | null = null;
  private prompt: string | null = null;
  private scan: { dist: number; angle: number } | null = null;
  private cacheMeshes = new Map<string, THREE.Group>();
  private cachePosCache = new Map<string, THREE.Vector3>();
  private cacheBox = new THREE.BoxGeometry(0.9, 0.55, 0.6).translate(0, 0.27, 0);
  private cacheStrip = new THREE.BoxGeometry(0.92, 0.05, 0.62);
  private cacheMat = new THREE.MeshStandardMaterial({ color: 0x2f3a3f, roughness: 0.5, metalness: 0.6 });
  private cacheGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.7, 0.62) });
  private signalFade = 0;
  /** the hold is lost at most once every 10 minutes */
  private lastHoldLoss = -1e9;
  private deathNote = '';
  /** the arm raised to fire (0..1, eased) */
  private aimK = 0;
  private fakeT = 200;
  private beaconMesh: { root: THREE.Group; glow: THREE.MeshBasicMaterial; pool: THREE.MeshBasicMaterial; halo: THREE.SpriteMaterial };
  private flowers: THREE.Group | null = null;

  constructor(g: Game, markerLayer: HTMLElement) {
    this.g = g;
    const ice = new THREE.MeshStandardMaterial({ color: 0xcfe8ff, roughness: 0.18, metalness: 0, emissive: 0x0b1c2b, flatShading: true });
    const ore = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.55, flatShading: true });
    // dark crystals grow around the alien places: violet, faintly glowing
    const cry = new THREE.MeshStandardMaterial({ color: 0x3a2350, roughness: 0.12, metalness: 0.2, emissive: 0x1a0b2e, flatShading: true });
    this.meshes = {
      ice: new THREE.InstancedMesh(iceGeo(), ice, MAX_DEPOSITS), metal: new THREE.InstancedMesh(oreGeo(), ore, MAX_DEPOSITS),
      crystal: new THREE.InstancedMesh(iceGeo(), cry, MAX_DEPOSITS),
    };
    for (const m of Object.values(this.meshes)) {
      m.count = 0;
      m.frustumCulled = false; // instances move with the camera-relative origin every frame
      m.castShadow = true;
      m.receiveShadow = true;
      m.visible = false;
      g.scene.add(m);
    }
    // the things you lost: a small case with a steady (never blinking) light strip
    this.crateMesh = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.5), new THREE.MeshStandardMaterial({ color: 0x3b4149, roughness: 0.6, metalness: 0.4 }));
    box.position.y = 0.2;
    box.castShadow = true;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.05, 0.52), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.22, 0.62, 0.8) }));
    strip.position.y = 0.3;
    this.crateMesh.add(box, strip);
    this.crateMesh.visible = false;
    g.scene.add(this.crateMesh);
    const marker = (shape: string, color: string, text: string) => {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;display:none;white-space:nowrap;font-family:ui-monospace,monospace;';
      const dot = document.createElement('div');
      dot.style.cssText = shape;
      const label = document.createElement('div');
      label.style.cssText = `position:absolute;left:13px;top:-7px;font-size:11px;color:${text};text-shadow:0 0 4px #000;letter-spacing:.05em;`;
      // off screen it waits at the edge with a small steady arrow towards the point
      const arrow = document.createElement('div');
      arrow.style.cssText = `position:absolute;left:0;top:0;display:none;color:${color};font-size:12px;line-height:1;text-shadow:0 0 4px #000;`;
      arrow.textContent = '▲';
      el.append(dot, label, arrow);
      markerLayer.appendChild(el);
      return { el, label, arrow };
    };
    const cm = marker('width:12px;height:12px;border:1.5px solid #7dd3fc;transform:translate(-50%,-50%) rotate(45deg);position:absolute;left:0;top:0;box-sizing:border-box;', '#7dd3fc', '#7dd3fc');
    this.crateMarker = cm.el; this.crateLabel = cm.label; this.crateArrow = cm.arrow;
    // the objective: an amber diamond on the place to go
    const om = marker('width:13px;height:13px;border:2px solid #fbbf24;transform:translate(-50%,-50%) rotate(45deg);position:absolute;left:0;top:0;box-sizing:border-box;', '#fbbf24', '#fcd34d');
    this.objMarker = om.el; this.objLabel = om.label; this.objArrow = om.arrow;
    // a light beacon: a short post with a warm steady light and the glow it casts on the ground
    {
      const root = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 1.1, 6).translate(0, 0.55, 0), new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.6, metalness: 0.5 }));
      post.castShadow = true;
      const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.78, 0.45) });
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), glow);
      bulb.position.y = 1.15;
      const tex = radialTexture([[0, 'rgba(255,214,150,0.9)'], [0.35, 'rgba(255,190,110,0.35)'], [1, 'rgba(255,170,90,0)']], 128);
      const pool = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.4, polygonOffset: true, polygonOffsetFactor: -2 });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(14, 40).rotateX(-Math.PI / 2), pool);
      disc.position.y = 0.08;
      disc.renderOrder = 2;
      const halo = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 });
      const sp = new THREE.Sprite(halo);
      sp.scale.setScalar(2.2);
      sp.position.y = 1.15;
      root.add(post, bulb, disc, sp);
      root.visible = false;
      g.scene.add(root);
      this.beaconMesh = { root, glow, pool, halo };
    }
    this.enemies = new EnemyDirector(g, this.sfx);
    this.enemies.onGuardianDown = () => this.guardianDown();
    this.loot = new LootSystem(g);
    this.events = new TravelEvents(g);
    this.vega = new Vega(this.sfx);
    this.vega.format = (t) => g.fmt(t);
    this.vega.onShow = (text, fake) => g.log(fake ? `«${text}»` : `VEGA: ${text}`, true);
    // VEGA comments the first meeting with each thing, and the dangers
    const firstSeen: Record<string, string> = {
      'seen:stalker': VEGA.stalker, 'seen:swarm': VEGA.swarm, 'seen:spitter': VEGA.spitter, 'seen:colossus': VEGA.colossus,
      'seen:tracker': VEGA.tracker, 'seen:sentinel': VEGA.sentinel, 'kill:colossus': VEGA.colossusDown, hunters: VEGA.hunters,
      lamp: VEGA.lamp, heart: VEGA.heart, phase2: VEGA.phase2, phase3: VEGA.phase3, pylonGlow: VEGA.pylonGlow,
    };
    this.enemies.onEvent = (ev) => {
      if (ev === 'zone') this.vega.say(VEGA.zone, 'zone', { cooldown: 240 });
      else if (firstSeen[ev]) this.vega.say(firstSeen[ev], ev, { once: true });
    };
    this.events.onEvent = (ev) => this.vega.say(VEGA[ev], ev, { cooldown: 45 });
    g.ship.cannons.forEach((c) => (c.visible = true));
    window.addEventListener('pagehide', this.onHide);
  }

  // -------------------------------------------------------------------------
  // Upgrades and their effects
  /** multipliers from the upgrades: damage taken / dealt, battery use, oxygen use, fuel use, suit capacity */
  mods() {
    const u = this.upgrades;
    return {
      taken: u.has('armor') ? 0.65 : 1,
      dealt: u.has('rifle') ? 1.6 : 1,
      energy: u.has('battery') ? 0.65 : 1,
      o2: u.has('o2') ? 0.6 : 1,
      fuel: u.has('engine') ? 0.7 : 1,
      cap: u.has('cargo') ? 40 : CARGO_CAP,
    };
  }
  /** buy an upgrade with what is in the ship's hold (only aboard) */
  buy(id: UpgradeId): string | null {
    const up = UPGRADES.find((x) => x.id === id)!;
    if (this.upgrades.has(id)) return 'Ya la tienes';
    if (this.g.mode !== 'ship') return 'Solo a bordo de la nave';
    if (this.stored.metal < up.metal || this.stored.crystal < up.crystal) return 'Faltan materiales en la bodega';
    this.stored.metal -= up.metal;
    this.stored.crystal -= up.crystal;
    this.upgrades.add(id);
    this.g.note(`Mejora instalada: ${up.name}`);
    this.save();
    return null;
  }
  /** make a medkit or a light beacon aboard, with what is in the hold */
  craft(id: CraftId): string | null {
    const c = CRAFTS.find((x) => x.id === id)!;
    if (this.g.mode !== 'ship') return 'Solo a bordo de la nave';
    if (id === 'medkit' && this.medkits >= 5) return 'Ya llevas 5 botiquines';
    if (id === 'beacon' && this.beacons >= 3) return 'Ya llevas 3 balizas';
    if (this.stored.metal < c.metal || this.stored.crystal < c.crystal) return 'Faltan materiales en la bodega';
    this.stored.metal -= c.metal;
    this.stored.crystal -= c.crystal;
    if (id === 'medkit') this.medkits++; else this.beacons++;
    this.g.note(`Fabricado: ${c.name}`);
    this.vega.say(VEGA.crafted, 'crafted', { cooldown: 120 });
    this.save();
    return null;
  }
  get hasScanner() { return this.logsRead.has('tsio-3'); }
  /** what R (USAR) would do right now, on foot */
  get currentPrompt() { return this.g.mode === 'foot' ? this.prompt : null; }
  get hasDispersor() { return this.upgrades.has('dispersor'); }

  // -------------------------------------------------------------------------
  // The story: Earth's recordings, Base Tsiolkovsky, the three fragments, the Spire
  objective(): Objective {
    const i = LOGS.findIndex((l) => !this.logsRead.has(l.id));
    if (i >= 0) return objectiveAt(i);
    const base = BASE_LOGS.filter((l) => this.logsRead.has(l.id)).length;
    if (base < BASE_LOGS.length) {
      return { text: base === 0 ? 'Viaja a la cara oculta de la Luna: la Base Tsiolkovsky' : `Explora la Base Tsiolkovsky: registros y el artefacto (${base}/${BASE_LOGS.length})`, place: 'tsiolkovsky' };
    }
    const left = FRAGMENTS.filter((f) => !this.logsRead.has(f.id));
    if (left.length) {
      // the nearest one in this star system first, else the next in order
      const g = this.g;
      const here = left.filter((f) => g.alien.body(g.alien.site(f.site)!).star === g.sunBody);
      const pick = (here.length ? here : left)[0];
      return { text: `Recupera los fragmentos del mapa (${FRAGMENTS.length - left.length}/${FRAGMENTS.length}): Marte, Europa y Próxima b`, place: pick.site };
    }
    if (!this.enemies.guardianDown) return { text: 'Viaja a TRAPPIST-1 e y apaga el faro: la Aguja', place: 'spire' };
    if (!this.planted) {
      return this.mementos.has('m-semillas')
        ? { text: 'Epílogo: planta las semillas de girasol junto a la baliza de Nueva Esperanza', place: 'esperanza' }
        : { text: 'Epílogo: busca el sobre de semillas en el refugio de Nueva Esperanza', place: 'esperanza' };
    }
    return { text: 'La señal se ha apagado. El universo es tuyo', place: '' };
  }
  /** the mission points the story has revealed so far, in order, each with its state; then the optional ones */
  missionPlaces(): Place[] {
    const g = this.g, read = (id: string) => this.logsRead.has(id);
    const obj = this.objective().place;
    const out: Place[] = [];
    const add = (id: string, done: boolean) => {
      const p = g.placeOf(id);
      if (p) out.push({ ...p, status: id === obj ? 'objetivo' : done ? 'hecho' : 'pendiente' });
    };
    const first = LOGS.findIndex((l) => !read(l.id));
    LOGS.forEach((l, i) => { if (first < 0 || i <= first) add(l.site, read(l.id)); });
    if (first < 0 || BASE_LOGS.some((l) => read(l.id))) add('tsiolkovsky', BASE_LOGS.every((l) => read(l.id)));
    if (this.hasScanner) for (const f of FRAGMENTS) add(f.site, read(f.id));
    if (FRAGMENTS.every((f) => read(f.id))) add('spire', this.enemies.guardianDown);
    // optional: the hidden caches the scanner hears (the world, not the spot), a distress signal
    if (this.hasScanner) for (const c of CACHES) if (!this.cachesOpen.has(c.id)) { const p = this.cachePlace(c.id); if (p) out.push({ ...p, status: 'pendiente', optional: true }); }
    const ev = this.events.place();
    if (ev) out.push({ ...ev, status: 'pendiente', optional: true });
    return out;
  }
  /** a hidden cache as the map knows it: only its world */
  cachePlace(id: string): Place | null {
    const c = CACHES.find((x) => x.id === id);
    const b = c ? this.g.byId.get(c.body) : undefined;
    if (!c || !b) return null;
    const parent = b.def.parent ? this.g.byId.get(b.def.parent) : undefined;
    return {
      id, name: `Señal débil · ${b.def.name}${parent && parent.def.kind !== 'star' ? ` (${parent.def.name})` : ''}`, body: c.body, world: b.def.name, system: b.star.def.name,
      desc: 'El escáner oye algo escondido en este mundo. No da el punto exacto: al llegar, sigue la aguja del escáner.', optional: true,
    };
  }

  private guardianDown() {
    this.ending = true;
    this.ended = true;
    this.signalFade = 0.001;
    this.save();
  }
  /** the end sequence closed */
  finishEnding() {
    this.ending = false;
    this.vega.say(VEGA.end, 'end', { once: true, story: true });
    if (this.mementos.has('m-semillas') && !this.planted) this.vega.say(VEGA.epilogue, 'epilogue', { once: true, story: true });
    this.g.note('La señal se ha apagado. Puedes seguir explorando: los secretos y las mejoras siguen ahí');
    this.g.requestLock();
  }

  /** world position of the objective, or null when it is not in this star system */
  private objectivePos(o: Objective, out: THREE.Vector3): THREE.Vector3 | null {
    const g = this.g;
    if (!o.place) return null;
    const al = g.alien.site(o.place);
    if (al) {
      const b = g.alien.body(al);
      // in another star system: point at its star
      if (b.star !== g.sunBody) return out.copy(b.star.pos);
      return g.alien.centre(al, out);
    }
    const s = this.ruins.site(o.place);
    const earth = g.byId.get('earth')!;
    if (!s || earth.star !== g.sunBody) return null;
    return out.copy(s.logPos).add(earth.pos);
  }

  openLog(l: LogEntry) {
    this.reading = l;
    if (document.pointerLockElement) document.exitPointerLock();
  }
  closeLog() {
    const l = this.reading;
    if (!l) return;
    this.reading = null;
    if (l.site === 'memento') {
      this.g.note(`Recuerdo guardado en tu colección (${this.mementos.size}/${MEMENTOS.length}). Están en el mapa, en REGISTROS`);
      this.save();
      this.g.requestLock();
      return;
    }
    if (l.id === 'epilogue') {
      this.vega.say(VEGA.planted, 'planted', { once: true, story: true });
      this.save();
      this.g.requestLock();
      return;
    }
    this.lastProgress = this.playTime;
    if (VEGA_STORY[l.id]) this.vega.say(VEGA_STORY[l.id], `story:${l.id}`, { once: true, story: true });
    const first = !this.logsRead.has(l.id);
    this.logsRead.add(l.id);
    if (first) {
      const g = this.g;
      if (l.id === 'tsio-3') g.note('Escáner sincronizado: ahora oyes los fragmentos del mapa y las señales escondidas');
      else if (FRAGMENTS.includes(l)) g.note(`Fragmento del mapa recuperado (${FRAGMENTS.filter((f) => this.logsRead.has(f.id)).length}/${FRAGMENTS.length})`);
      else g.note(`Registro guardado: ${l.title}. Puedes releerlo en el mapa`);
      g.note(`Objetivo: ${this.objective().text}`);
      this.save();
    }
    this.g.requestLock();
  }

  /** the wake-up sequence ended: first instructions */
  finishIntro() {
    if (!this.intro) return;
    this.intro = false;
    const g = this.g;
    g.note(`Objetivo: ${this.objective().text}. Sigue el rombo ◆`);
    g.note('En la Tierra el aire aún se respira; en los demás mundos el oxígeno del traje dura 6 minutos');
    g.note(`Cada salto gasta combustible. Extrae hielo y metal con ${g.touchMode ? 'MINAR' : 'R'}`);
  }

  private onHide = () => this.save();

  dispose() {
    window.removeEventListener('pagehide', this.onHide);
    this.crateMarker.remove();
    this.objMarker.remove();
    this.enemies.dispose();
    this.loot.dispose();
    this.g.scene.remove(this.beaconMesh.root);
    if (this.flowers) this.g.scene.remove(this.flowers);
  }

  private total(c: Cargo) { return c.ice + c.metal + c.crystal; }
  private cargoText(c: Cargo) {
    const p: string[] = [];
    if (c.ice) p.push(`${c.ice} hielo`);
    if (c.metal) p.push(`${c.metal} metal`);
    if (c.crystal) p.push(`${c.crystal} cristal`);
    return p.join(' · ');
  }

  // -------------------------------------------------------------------------
  // Simulation (not while paused or dead)
  update(dt: number) {
    const g = this.g;
    this.playTime += dt;
    const foot = g.mode === 'foot';
    if (foot) {
      // breathing: Earth's air is still breathable (the suit tops its tank up); anywhere else the tank empties
      const run = g.keys.has('ShiftLeft') || g.keys.has('ShiftRight');
      if (g.nearest.def.id === 'earth') this.oxygen = Math.min(100, this.oxygen + dt * 5);
      else this.oxygen = Math.max(0, this.oxygen - dt * O2_RATE * this.mods().o2 * (run ? O2_RUN : 1));
      if (this.oxygen <= 0) {
        g.suit -= dt * NO_O2_DAMAGE;
        // a slow soft pulse at the edge of the view while there is no air (never a flash)
        g.hurt = Math.max(g.hurt, 0.3 + 0.12 * Math.sin(this.playTime * 1.3));
        g.hurtDir = null;
        g.warnings.push('SIN OXÍGENO · VUELVE A LA NAVE');
        if (g.suit <= 0) g.die('Te quedaste sin oxígeno lejos de la nave.');
      } else if (this.oxygen < 25) g.warnings.push(`OXÍGENO ${this.oxygen.toFixed(0)}%`);
      // dead (out of air, or a fall or hazard earlier this frame): the case just dropped stays there
      if (g.dead) return;
      // battery: the flashlight drains it, the suit's panels charge it in sunlight
      const sunlit = clamp(g.light.intensity / 3.3, 0, 1);
      this.energy = clamp(this.energy + dt * (SOLAR_CHARGE * sunlit - (g.lightsOn ? LAMP_DRAIN * this.mods().energy : 0)), 0, 100);
      if (this.energy <= 0 && g.lightsOn) {
        g.lightsOn = false;
        g.note('Batería agotada: la linterna se apagó. Se recarga al sol o en la nave');
      }
      this.updateMining(dt);
      this.updateCrate();
      this.updateKit(dt);
      this.updateTrials(dt);
    } else {
      // aboard: the ship's life support refills the suit and treats you
      this.oxygen = Math.min(100, this.oxygen + dt * 20);
      this.energy = Math.min(100, this.energy + dt * 4);
      g.suit = Math.min(100, g.suit + dt * 2);
      if (this.total(this.carried) > 0) {
        g.note(`Descargado en la bodega: ${this.cargoText(this.carried)}`);
        for (const k of RES_KINDS) this.stored[k] += this.carried[k];
        this.carried = emptyCargo();
      }
      this.updateRefinery(dt);
      if (this.fuel < 15 && !g.warp) g.warnings.push(`COMBUSTIBLE ${this.fuel.toFixed(0)}%`);
      this.mineProgress = 0;
      this.mineTarget = null;
      this.nearDeposit = null;
      this.translate = null;
    }
    // the first steps on each world
    if (foot && !this.wasFoot) {
      const id = g.nearest.def.id;
      this.vega.say(VEGA.first, 'first', { once: true });
      const line = VEGA_LAND[id];
      if (line) this.vega.say(line, `land:${id}`, { once: true });
      // where the place itself takes health away: how long the suit lasts out here (the drain the suit really feels)
      const d = g.hazardDrain(g.nearest, g.playerPos);
      const hz = g.nearest.def.hazard?.text ?? '';
      if (d >= 0.3) {
        const min = String(Math.max(1, Math.round(g.suit / (d * 60))));
        const line = /radiaci/i.test(hz) ? VEGA.radiation.replace('{MIN}', min) : `Aquí el lugar mismo te quita salud (${hz.toLowerCase() || 'el traje sufre'}): tienes unos ${min} minutos fuera de la nave.`;
        this.vega.say(line, `rad:${id}`, { once: true });
      }
    }
    // the planted beacon burns down
    if (this.beacon && (this.beacon.t -= dt) <= 0) this.beacon = null;
    // the ruined towns walked into
    if (foot && g.nearest.def.id === 'earth' && g.frame % 30 === 0) {
      const n = this.ruins.nearest(g.playerPos, 2000);
      if (n && n.dist < n.site.radius && !this.visited.has(n.site.id)) {
        this.visited.add(n.site.id);
        if (n.site.id.startsWith('town-')) g.note(`Pueblo en ruinas: ${n.site.name} (${[...this.visited].filter((v) => v.startsWith('town-')).length}/16)`);
      }
    }
    // what lives in the dark
    this.enemies.update(dt);
    this.events.update(dt);
    if (this.enemies.boss()) this.vega.say(VEGA.guardian, 'guardian', { once: true });
    if (this.playTime - this.lastProgress > 300) this.vega.say(VEGA.idle, 'idle', { cooldown: 600 });
    this.updateVoices(dt, foot);
    this.vega.update(dt);
    if (g.suit <= 0 && !g.dead) {
      const why = this.enemies.lastHit;
      const dark = g.light.intensity / 3.3 < 0.25;
      g.die(DEATH[why] ?? (dark ? DEATH.dark : DEATH.day));
      return;
    }
    if (g.mode === 'ship' && g.hull <= 0 && !g.dead && this.enemies.lastHit === 'hunter') {
      g.die(DEATH.hunter);
      return;
    }
    // the astronaut faces where you look: the flashlight and the weapon point there
    if (foot) {
      const up = g.playerPos.clone().sub(g.nearest.pos).normalize();
      const f = g.camFwd.clone().projectOnPlane(up);
      if (f.lengthSq() > 1e-6 && !g.swimming) g.playerFacing.copy(f.normalize());
    }
    // the arm comes up to fire, smoothly, and goes back down
    this.aimK = clamp(this.aimK + (foot && this.enemies.sinceShot < 0.45 ? dt : -dt) / 0.1, 0, 1);
    const ar = g.astro.armR;
    // (+x lifts the arm forwards; a touch inwards, towards the crosshair)
    ar.rotation.x = ar.rotation.x * (1 - this.aimK) + 1.45 * this.aimK;
    ar.rotation.z = -0.12 * this.aimK;
    g.astro.weapons.rifle.visible = foot && this.weapon === 'rifle';
    g.astro.weapons.dispersor.visible = foot && this.weapon === 'dispersor';
    // boarding the ship is a good moment to save
    if (this.wasFoot && !foot) this.save();
    this.wasFoot = foot;
    this.saveT += dt;
    if (this.saveT > AUTOSAVE) this.save();
  }

  /** "do not answer voices you know": very rarely, in the deepest dark, someone else talks in VEGA's box */
  private updateVoices(dt: number, foot: boolean) {
    const g = this.g;
    const dark = 1 - clamp(g.light.intensity / 3.3 / 0.35, 0, 1);
    if (!foot || dark < 0.9 || !this.enemies.inZone || !this.logsRead.has('beacon') || this.ended) return;
    this.fakeT -= dt;
    if (this.fakeT > 0 || this.vega.busy) return;
    this.fakeT = 300 + Math.random() * 420;
    if (this.vega.sayFake(FAKE_VOICES[Math.floor(Math.random() * FAKE_VOICES.length)])) {
      // a moment later, the real one
      this.vega.say(VEGA.notMe, 'notMe', { cooldown: 900 });
    }
  }

  canLight() { return this.energy > 1; }

  /** on foot: B medkit, Q dash, Z light beacon, 1 / 2 weapons; VEGA warns when things run low */
  private dashCD = 0;
  private updateKit(dt: number) {
    const g = this.g, k = g.keys;
    if (g.pressed.has('KeyB')) {
      if (this.medkits <= 0) { g.note('No te quedan botiquines'); this.vega.say(VEGA.noMedkit, 'noMedkit', { cooldown: 60 }); }
      else if (g.suit >= 99) g.note('Tu salud está completa');
      else {
        this.medkits--;
        g.suit = Math.min(100, g.suit + 45);
        this.sfx.play('heal');
        g.note(`Botiquín usado: +45 de salud (te quedan ${this.medkits})`);
      }
    }
    this.dashCD -= dt;
    const dashCost = 4 * this.mods().energy;
    if (g.pressed.has('KeyQ') && this.dashCD <= 0 && this.energy >= dashCost && !g.swimming) {
      const up = g.playerPos.clone().sub(g.nearest.pos).normalize();
      const right = new THREE.Vector3().crossVectors(g.camFwd, up).normalize();
      const mv = g.camFwd.clone().multiplyScalar((k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0)).addScaledVector(right, (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0));
      // the push goes through the game's own movement: the ground and the walls still hold
      g.footImpulse = { dir: mv.lengthSq() > 0.01 ? mv.normalize() : g.camFwd.clone(), t: DASH_TIME, speed: DASH_SPEED };
      this.dashCD = 1.2;
      this.energy -= dashCost;
      this.sfx.play('dash');
    }
    if (g.pressed.has('KeyZ')) this.plantBeacon();
    if (g.pressed.has('Digit1') && this.weapon !== 'rifle') { this.weapon = 'rifle'; g.note('Fusil de arco'); }
    if (g.pressed.has('Digit2') || g.pressed.has('WeaponToggle')) {
      const want = g.pressed.has('Digit2') ? 'dispersor' : this.weapon === 'rifle' ? 'dispersor' : 'rifle';
      if (want === 'dispersor' && !this.hasDispersor) g.note('Aún no tienes el dispersor: el ejército guardaba uno en Ciudad Meridiano');
      else if (want !== this.weapon) { this.weapon = want; g.note(want === 'dispersor' ? 'Dispersor de pulsos: devastador de cerca' : 'Fusil de arco'); }
    }
    if (g.nearest.def.id !== 'earth' && this.oxygen < 25) this.vega.say(VEGA.lowO2, 'lowO2', { cooldown: 120 });
    if (this.energy < 15) this.vega.say(VEGA.lowBattery, 'lowBattery', { cooldown: 120 });
    if (g.suit < 35) this.vega.say(this.medkits ? VEGA.lowHealth : VEGA.noMedkit, 'lowHealth', { cooldown: 90 });
  }

  /** a light beacon into the ground here: what fears the light keeps away for two minutes */
  private plantBeacon() {
    const g = this.g;
    if (this.beacons <= 0) { g.note('No llevas balizas de luz: se fabrican a bordo con metal y cristal (mapa · MEJORAS)'); return; }
    if (g.swimming) { g.note('Aquí no se puede clavar: busca tierra firme'); return; }
    this.beacons--;
    const b = g.nearest;
    const p = g.playerPos.clone().addScaledVector(g.playerFacing, 1.2);
    const d = p.sub(b.pos).normalize();
    this.beacon = { body: b.def.id, off: d.multiplyScalar(b.def.radius + g.terrainH(b, d)), t: BEACON_TIME };
    this.sfx.play('chime');
    this.vega.say(VEGA.beacon, 'beacon', { once: true });
    g.note(`Baliza de luz clavada: 2 minutos de luz (te quedan ${this.beacons})`);
  }

  /** the trials of the three fragments (survival rules on the same places as exploration) */
  private updateTrials(dt: number) {
    const g = this.g, b = g.nearest;
    if (!this.hasScanner) return;
    // Mars: the flashlight finds the three dark stones; each keeps glowing once lit
    if (b.def.id === 'mars' && !this.logsRead.has('frag-mars')) {
      const s = g.alien.site('frag-mars')!;
      if (g.alien.centre(s, new THREE.Vector3()).distanceTo(g.playerPos) < 60) {
        const eye = g.playerPos.clone().addScaledVector(g.playerPos.clone().sub(b.pos).normalize(), 1.6);
        MARS_STONES.forEach((_, k) => {
          if (this.marks.has(`mars-${k}`)) return;
          const sp = g.alien.stonePoint(k);
          const to = sp.clone().sub(eye);
          const lit = g.lightsOn && to.length() < 14 && to.normalize().dot(g.playerFacing) > Math.cos((28 * Math.PI) / 180);
          this.marsT[k] = lit ? this.marsT[k] + dt : Math.max(0, this.marsT[k] - dt);
          if (this.marsT[k] >= 1.5) {
            this.marks.add(`mars-${k}`);
            this.sfx.play('chime', sp.sub(g.camWorld));
            const n = MARS_STONES.filter((_, j) => this.marks.has(`mars-${j}`)).length;
            g.note(n < 3 ? `Una de las piedras despierta: sus líneas se quedan encendidas (${n}/3)` : 'Las tres piedras brillan: la inscripción del monolito está completa');
            this.save();
          }
        });
      }
    }
    // Proxima b: the scanner translates while the pilot stays close (and the night answers)
    const tr = this.translate;
    if (tr) {
      const s = g.alien.site('frag-proxima')!;
      const [x, z] = SITE_POINTS.monolith.glyph;
      const near = b.def.id === 'proxima-b' && g.alien.point(s, x, z).distanceTo(g.playerPos) < 4.5;
      if (near) tr.t += dt;
      if (tr.t >= TRANSLATE_TIME) {
        this.translate = null;
        this.sfx.play('chime');
        this.openLog(FRAGMENTS.find((f) => f.id === 'frag-proxima')!);
      }
    }
    // the lit stones of Mars shine on (eased)
    for (let k = 0; k < 3; k++) {
      const want = this.marks.has(`mars-${k}`) ? 1 : clamp(this.marsT[k] / 1.5, 0, 1) * 0.5;
      g.alien.marsLit[k] += (want - g.alien.marsLit[k]) * Math.min(1, dt * 2);
    }
  }

  /** open a crate, a shelter or a wreck: its contents, maybe a memento, maybe company; what does not fit stays inside */
  private openSpot(s: LootSpot) {
    const g = this.g;
    this.lastProgress = this.playTime;
    const first = !this.loot.opened.has(s.id) && !this.loot.left.has(s.id);
    const got: string[] = [], left: LootItem[] = [];
    let memento: Memento | null = null;
    for (const it of this.loot.items(s)) {
      if (it.k === 'medkit') {
        const n = Math.min(5 - this.medkits, it.n);
        if (n > 0) { this.medkits += n; got.push(n > 1 ? `${n} botiquines` : 'botiquín'); }
        if (it.n > n) left.push({ k: 'medkit', n: it.n - n });
      } else if (it.k === 'battery') { this.energy = Math.min(100, this.energy + 40); got.push('celda de batería'); }
      else if (it.k === 'o2') { this.oxygen = Math.min(100, this.oxygen + 40); got.push('cartucho de oxígeno'); }
      else if (it.k === 'metal' || it.k === 'crystal') {
        const n = this.addCargo(it.k, it.n);
        if (n) got.push(`${n} ${RES_LABEL[it.k]}`);
        if (n < it.n) left.push({ k: it.k, n: it.n - n });
      } else if (it.k === 'memento') {
        memento = (it.id && !this.mementos.has(it.id) ? MEMENTOS.find((m) => m.id === it.id) : undefined) ?? MEMENTOS.find((m) => !this.mementos.has(m.id)) ?? null;
      } else if (it.k === 'dispersor') { this.upgrades.add('dispersor'); got.push('¡el dispersor de pulsos!'); }
    }
    if (left.length) this.loot.left.set(s.id, left);
    else { this.loot.left.delete(s.id); this.loot.markOpen(s); }
    const what = s.kind === 'bunker' ? 'Refugio' : s.kind === 'wreck' ? 'Restos de la nave' : 'Caja de suministros';
    const rest = left.length ? ` · no te cabe y se queda dentro: ${left.map((i) => (i.k === 'medkit' ? `${i.n} botiquín` : `${i.n} ${RES_LABEL[i.k as Res]}`)).join(', ')}` : '';
    g.note(got.length ? `${what}: ${got.join(', ')}${rest}` : left.length ? `${what}: no te cabe nada más${rest}` : `${what}: no queda nada útil`);
    this.sfx.play(s.kind === 'wreck' ? 'clank' : 'creak');
    if (!first) { this.save(); return; }
    this.vega.say(s.kind === 'bunker' ? VEGA.bunker : VEGA.crate, s.kind === 'bunker' ? 'bunker' : 'crate', { once: true });
    if (s.items.some((i) => i.k === 'dispersor')) this.vega.say(VEGA.dispersor, 'dispersor', { once: true });
    if (s.ambush && !this.ended) {
      const dark = g.light.intensity / 3.3 < 0.25;
      this.enemies.ambush(dark ? 'night' : 'day', dark ? 3 : 2);
      this.vega.say(VEGA.ambushRuins, 'ambushRuins', { cooldown: 60 });
    }
    if (memento) {
      this.mementos.add(memento.id);
      this.vega.say(VEGA.memento, 'memento', { once: true });
      this.openLog({ id: memento.id, site: 'memento', title: memento.name, from: `Recuerdo · ${s.place}`, text: [memento.text] });
    } else this.save();
  }

  /** put things in the suit (up to its capacity); returns how many fitted */
  addCargo(kind: Res, n: number) {
    const got = Math.max(0, Math.min(n, this.mods().cap - this.total(this.carried)));
    this.carried[kind] += got;
    return got;
  }
  /** something found (a creature's crystal, a watcher's hide, a cache): into the suit; what does not fit stays on the ground (◇) */
  gain(kind: Res, n: number, why: string) {
    const g = this.g;
    const got = this.addCargo(kind, n);
    const rest = n - got;
    if (rest > 0 && g.mode === 'foot') {
      const c = emptyCargo();
      c[kind] = rest;
      this.dropCrate(c);
    } else if (rest > 0) this.stored[kind] += rest;
    if (rest > 0 && g.mode === 'foot') g.note(`${got ? `+${got} ${RES_LABEL[kind]} (${why}). ` : ''}El traje va lleno: ${rest} ${RES_LABEL[kind]} se quedan en el suelo ◇`);
    else g.note(`+${n} ${RES_LABEL[kind]}: ${why}`);
  }
  /** things left on the ground here join "TUS COSAS" (one case: the newest place keeps everything) */
  private dropCrate(c: Cargo, pos = this.g.playerPos) {
    const g = this.g;
    const off = pos.clone().sub(g.nearest.pos);
    const prev = this.crate ? this.crate.cargo : emptyCargo();
    const cargo = emptyCargo();
    for (const k of RES_KINDS) cargo[k] = c[k] + prev[k];
    this.crate = { body: g.nearest.def.id, off: [off.x, off.y, off.z], cargo };
  }

  private updateMining(dt: number) {
    const g = this.g;
    const p = g.playerPos;
    // something to listen to, read or open within reach: R does it
    this.prompt = null;
    let near: Interactable | null = null, nd = READ_RANGE;
    for (const it of this.interactables()) {
      const d = it.pos.distanceTo(p);
      if (d < nd) { nd = d; near = it; }
    }
    if (near) {
      this.prompt = near.prompt;
      if (g.pressed.has('KeyR')) near.act();
      this.mineProgress = 0;
      this.mineTarget = null;
      this.nearDeposit = null;
      return;
    }
    let best: Deposit | null = null, bd = MINE_RANGE;
    const w = new THREE.Vector3();
    for (const d of this.deposits) {
      const dist = w.copy(d.body.pos).add(d.off).distanceTo(p);
      if (dist < bd) { bd = dist; best = d; }
    }
    this.nearDeposit = best;
    const hold = g.keys.has('KeyR');
    if (!best || !hold) {
      if (g.pressed.has('KeyR') && !best) g.note('No hay nada que extraer aquí: busca cristales de hielo o rocas con vetas de metal');
      this.mineProgress = Math.max(0, this.mineProgress - dt * 2);
      if (this.mineProgress === 0) this.mineTarget = null;
      return;
    }
    const cap = this.mods().cap;
    if (this.total(this.carried) >= cap) {
      if (g.pressed.has('KeyR')) g.note(`Carga llena (${cap}): vuelve a la nave para descargarla`);
      return;
    }
    if (this.energy < MINE_ENERGY * this.mods().energy) {
      if (g.pressed.has('KeyR')) g.note('Batería insuficiente para extraer: recárgala al sol o en la nave');
      return;
    }
    if (this.mineTarget !== best) { this.mineTarget = best; this.mineProgress = 0; }
    this.mineProgress += dt / MINE_TIME;
    if (this.mineProgress >= 1) {
      const room = cap - this.total(this.carried);
      const got = Math.min(best.amount, room);
      this.carried[best.kind] += got;
      this.energy -= MINE_ENERGY * this.mods().energy;
      this.mined.add(best.key);
      if (this.mined.size > 4000) this.mined.delete(this.mined.values().next().value!);
      this.deposits.splice(this.deposits.indexOf(best), 1);
      this.sfx.play('step', undefined, 0.9);
      g.note(`+${got} ${RES_LABEL[best.kind]} · carga ${this.total(this.carried)}/${cap}`);
      if (best.key.startsWith('frag-europa:')) {
        const left = EUROPA_ICE.filter((_, k) => !this.mined.has(`frag-europa:ice:${k}`)).length;
        g.note(left ? `Hielo retirado de la inscripción (quedan ${left})` : 'La inscripción de Europa ha quedado a la vista');
      }
      this.mineProgress = 0;
      this.mineTarget = null;
      this.nearDeposit = null;
    }
  }

  private updateCrate() {
    const c = this.crate, g = this.g;
    if (!c || c.body !== g.nearest.def.id) return;
    const pos = new THREE.Vector3(...c.off).add(g.nearest.pos);
    if (pos.distanceTo(g.playerPos) > 3) return;
    const room = this.mods().cap - this.total(this.carried);
    if (room <= 0) { if (g.pressed.has('KeyR')) g.note('Carga llena: no puedes recoger tus cosas'); return; }
    const take = emptyCargo();
    let left = room;
    for (const k of ['crystal', 'metal', 'ice'] as Res[]) {
      const n = Math.min(c.cargo[k], left);
      take[k] = n; c.cargo[k] -= n; left -= n;
    }
    for (const k of RES_KINDS) this.carried[k] += take[k];
    if (this.total(c.cargo) === 0) {
      this.crate = null;
      g.note(`Recuperaste tus cosas: ${this.cargoText(take)}`);
    } else g.note(`Recogiste ${this.cargoText(take)}; aún quedan cosas en la caja`);
  }

  /** aboard: ice becomes fuel, metal repairs the hull, one unit at a time */
  private updateRefinery(dt: number) {
    const g = this.g;
    this.refineT += dt;
    this.refining = null;
    const fuelUse = this.fuel <= 100 - ICE_FUEL && this.stored.ice > 0;
    const hullUse = g.hull <= 100 - METAL_HULL && this.stored.metal > 0;
    if (fuelUse) this.refining = 'Hielo → combustible';
    else if (hullUse) this.refining = 'Metal → reparando el casco';
    if (this.refineT < 0.35) return;
    this.refineT = 0;
    if (fuelUse) { this.stored.ice--; this.fuel = Math.min(100, this.fuel + ICE_FUEL); }
    else if (hullUse) { this.stored.metal--; g.hull = Math.min(100, g.hull + METAL_HULL); }
  }

  // -------------------------------------------------------------------------
  // Ship engines (called from Game.updateShip)

  /** a world where an empty tank can be refilled: ice to dig and a suit that lasts there */
  private canRefuel(b: Body) {
    return b.def.kind === 'rocky' && (b.def.hazard?.suitDrain ?? 0) <= 1 && richness(b.def.id).ice >= 0.2;
  }
  /** ...and big enough to be the target of an emergency jump */
  private safeWorld(b: Body) { return this.canRefuel(b) && b.def.radius >= 100e3; }

  /** Pulse engine ignition. 'go' = jump, 'emergency' = jump on the reserve towards the nearest world, 'no' = stay. */
  jumpStart(): 'go' | 'emergency' | 'no' {
    const g = this.g;
    if (this.fuel >= JUMP_COST * this.mods().fuel + 1) {
      // VEGA says so when the tank will not last the trip
      const est = g.autopilot && g.target ? g.jumpEstimate() : null;
      if (est?.fuel != null && est.fuel > this.fuel) {
        g.note(`Combustible insuficiente para llegar a ${g.target!.def.name}: ≈ ${Math.ceil(est.fuel)}% (tienes ${Math.floor(this.fuel)}%)`);
        this.vega.say(VEGA.noFuelFar, 'noFuelFar', { cooldown: 30 });
      }
      this.fuel -= JUMP_COST * this.mods().fuel;
      this.emergency = false;
      return 'go';
    }
    const near = g.nearest;
    const alt = g.shipPos.distanceTo(near.pos) - near.def.radius;
    const close = near.def.kind === 'rocky' && alt < near.def.radius * 3;
    if (close && this.canRefuel(near)) {
      g.note(`Sin combustible para el salto: aterriza en ${near.def.name} y extrae hielo ({KeyR})`);
      return 'no';
    }
    const w = this.nearestWorld(g.shipPos);
    if (!w) { g.note('Sin combustible para el salto'); return 'no'; }
    if (close) this.vega.say(VEGA.noFuelUnsafe, 'noFuelUnsafe', { cooldown: 60 });
    this.beginEmergency(w);
    return 'emergency';
  }

  /** the nearest world of this system where an empty tank can be refilled */
  private nearestWorld(p: THREE.Vector3): Body | null {
    let best: Body | null = null, bd = Infinity;
    for (const b of this.g.bodies) {
      if (b.star !== this.g.sunBody || !this.safeWorld(b)) continue;
      const d = p.distanceTo(b.pos) - b.def.radius;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  private beginEmergency(w: Body) {
    const g = this.g;
    this.emergency = true;
    g.target = w;
    g.autopilot = true;
    g.hull = Math.max(5, g.hull - 15);
    g.note(`Combustible agotado: salto de emergencia hacia ${w.def.name}. La reserva daña el casco`);
  }

  /** Fuel burnt while warping; switches to an emergency jump when the tank runs dry. */
  warpBurn(dt: number, speed: number) {
    const g = this.g;
    if (this.emergency) {
      // between the stars the reserve barely holds: the hull pays for every second of it
      if (g.shipPos.distanceTo(g.sunBody.pos) > 2000 * AU) g.hull = Math.max(5, g.hull - dt * 0.8);
      return;
    }
    const rate = (0.25 + 0.12 * Math.max(0, Math.log10(speed / 1e6))) * this.mods().fuel;
    this.fuel = Math.max(0, this.fuel - rate * dt);
    if (this.fuel <= 0) {
      const w = this.nearestWorld(g.shipPos);
      if (w) {
        if (g.shipPos.distanceTo(g.sunBody.pos) > 2000 * AU) this.vega.say(VEGA.noFuelFar, 'noFuelFar', { cooldown: 30 });
        this.beginEmergency(w);
      }
    }
  }
  warpEnded() {
    // sometimes something was waiting at the end of the jump (once the story has spoken of them)
    if (!this.emergency && !this.ended && this.logsRead.has('tsio-2') && Math.random() < 0.12) {
      this.enemies.hunterAmbush(2);
      this.vega.say(VEGA.ambushSpace, 'ambushSpace', { cooldown: 45 });
    }
    this.emergency = false;
  }

  /** Fuel burnt by the normal engines; returns their power factor (reduced on an empty tank). */
  thrustBurn(dt: number, throttle: number, boost: boolean, vert: number) {
    const use = (Math.abs(throttle) * (boost ? 4 : 1) + Math.abs(vert) * 0.4) * THRUST_BURN * dt;
    if (this.fuel <= 0) return RESERVE_POWER;
    this.fuel = Math.max(0, this.fuel - use);
    if (this.fuel <= 0) this.g.note('Tanque vacío: propulsores de reserva al 30%. Aterriza y extrae hielo');
    return 1;
  }

  // -------------------------------------------------------------------------
  // Death and waking up

  onDeath(onFoot: boolean) {
    this.deaths++;
    this.enemies.clear();
    this.translate = null;
    if (onFoot) {
      if (this.total(this.carried) > 0) {
        this.dropCrate(this.carried);
        this.carried = emptyCargo();
      }
      this.deathNote = 'Despertarás a bordo de la nave. Lo que llevabas encima quedará donde caíste: podrás ir a buscarlo.';
    } else if (this.playTime - this.lastHoldLoss > 600) {
      // the wreck: part of the hold is lost (at most once every ten minutes)
      for (const k of RES_KINDS) this.stored[k] = Math.floor(this.stored[k] * 0.7);
      this.lastHoldLoss = this.playTime;
      this.deathNote = 'La nave se reconstruirá en órbita con lo que quedó: casco al 40% y parte de la bodega perdida.';
    } else this.deathNote = 'La nave se reconstruirá en órbita: casco al 40%. La bodega aguantó esta vez.';
  }

  /** after REAPARECER: the mild penalty is applied, then the game is saved */
  onRevive(ship: boolean) {
    const g = this.g;
    this.oxygen = 100;
    this.mineProgress = 0;
    this.emergency = false;
    if (ship) {
      g.hull = 40;
      this.fuel = Math.max(this.fuel, 25);
      g.note('Nave reconstruida en órbita con lo que quedaba: casco al 40%');
      // the void rays leave the rebuilt ship alone for a while
      this.enemies.calm(30);
      const id = g.nearest.def.id;
      if ((id === 'proxima-b' || id === 'trappist-1e') && !this.enemies.guardianDown) this.vega.say(VEGA.huntersRespawn, 'huntersRespawn', { cooldown: 120 });
    } else {
      g.suit = 50;
      g.note(this.crate ? 'Despiertas a bordo. Lo que llevabas quedó donde caíste: sigue la señal ◇' : 'Despiertas a bordo de la nave');
    }
    this.vega.say(VEGA.revive, 'revive', { cooldown: 120 });
    this.save();
  }

  // -------------------------------------------------------------------------
  // Drawing (every frame, also while paused)

  render() {
    const g = this.g;
    const body = g.nearest;
    const cw = g.camWorld;
    this.renderObjective();
    this.enemies.render();
    this.loot.update();
    this.renderCaches();
    this.renderBeacon();
    this.renderFlowers();
    // the signal dies: the alien glyphs fade out over a few seconds
    if (this.signalFade > 0 && g.alien.signal > 0) g.alien.signal = Math.max(0, 1 - (this.signalFade += 1 / 60) / 5);
    else if (this.ended) g.alien.signal = 0;
    const focus = g.mode === 'ship' ? g.shipPos : g.playerPos;
    const near = body.def.kind === 'rocky' && !!body.terrain && g.altitude < 2500 && !g.warp;
    if (near) this.refreshField(body, focus);
    else if (this.fieldKey) { this.fieldKey = ''; this.deposits = []; }
    const counts: Record<Res, number> = { ice: 0, metal: 0, crystal: 0 };
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3();
    for (const d of this.deposits) {
      const im = this.meshes[d.kind];
      const i = counts[d.kind]++;
      if (i >= MAX_DEPOSITS) continue;
      // the deposit being mined shrinks as it is extracted
      const k = d === this.mineTarget ? 1 - 0.55 * this.mineProgress : 1;
      p.copy(body.pos).sub(cw).add(d.off);
      s.setScalar(d.scale * k);
      im.setMatrixAt(i, m.compose(p, d.q, s));
    }
    for (const k of RES_KINDS) {
      const im = this.meshes[k];
      im.count = Math.min(counts[k], MAX_DEPOSITS);
      im.visible = im.count > 0;
      im.instanceMatrix.needsUpdate = true;
    }
    // the things you lost
    const c = this.crate;
    this.crateDist = null;
    const cb = c ? g.byId.get(c.body) : undefined;
    if (c && cb && cb.star === g.sunBody) {
      const rel = new THREE.Vector3(...c.off).add(cb.pos).sub(cw);
      // distance from the astronaut (or the ship), not from the camera behind them
      const dist = new THREE.Vector3(...c.off).add(cb.pos).distanceTo(focus);
      if (cb === body) this.crateDist = dist;
      this.crateMesh.visible = dist < 3000;
      if (this.crateMesh.visible) {
        this.crateMesh.position.copy(rel);
        const up = new THREE.Vector3(...c.off).normalize();
        this.crateMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      }
      if (g.vision) { css(this.crateMarker, 'display', 'none'); return; }
      // on this world it waits at the edge of the screen when out of view
      g.pinMarker(this.crateMarker, this.crateArrow, rel, cb === body);
      if (g.frame % 6 === 0) {
        const txt = dist < 1000 ? `${dist.toFixed(0)} m` : dist < 1e6 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist / 1000).toLocaleString('es-ES')} km`;
        this.crateLabel.textContent = `TUS COSAS  ${txt}`;
      }
    } else {
      this.crateMesh.visible = false;
      css(this.crateMarker, 'display', 'none');
    }
  }

  /** the planted beacon: a warm steady light that comes on gently and fades at the end */
  private renderBeacon() {
    const g = this.g, bc = this.beacon, bm = this.beaconMesh;
    const b = bc ? g.byId.get(bc.body) : undefined;
    bm.root.visible = !!bc && !!b && b === g.nearest;
    if (!bc || !b || !bm.root.visible) return;
    // it comes on slowly (2.5 s) and goes out slowly (5 s): never a sudden light
    const up = clamp((BEACON_TIME - bc.t) / 2.5, 0, 1);
    const k = up * up * (3 - 2 * up) * Math.min(1, bc.t / 5) * (g.lightsMode === 'comfort' ? 0.6 : 1);
    bm.root.position.copy(b.pos).add(bc.off).sub(g.camWorld);
    bm.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), bc.off.clone().normalize());
    bm.glow.color.setRGB(1.0 * k, 0.78 * k, 0.45 * k);
    bm.pool.opacity = 0.4 * k;
    bm.halo.opacity = 0.5 * k;
  }
  /** the epilogue's sunflowers, by the beacon of Nueva Esperanza */
  private renderFlowers() {
    const g = this.g;
    if (!this.planted) return;
    const s = this.ruins.site('esperanza'), earth = g.byId.get('earth')!;
    if (!s || earth.star !== g.sunBody) { if (this.flowers) this.flowers.visible = false; return; }
    const pos = s.logPos.clone().addScaledVector(s.east, 2.2).addScaledVector(s.north, -1.2);
    const d = pos.clone().normalize();
    pos.copy(d).multiplyScalar(earth.def.radius + g.terrainH(earth, d)).add(earth.pos);
    const near = pos.distanceTo(g.camWorld) < 2000;
    if (!this.flowers && near) {
      this.flowers = sunflowers();
      g.scene.add(this.flowers);
    }
    if (!this.flowers) return;
    this.flowers.visible = near;
    this.flowers.position.copy(pos).sub(g.camWorld);
    // they face the Sun, which never moves in this sky
    const up = d, sun = earth.star.pos.clone().sub(pos).normalize();
    const z = sun.clone().addScaledVector(up, -sun.dot(up));
    if (z.lengthSq() < 1e-6) z.copy(s.north);
    z.normalize();
    this.flowers.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, z), up, z));
  }

  /** Deposits around the player: the same ones every visit (hashed from the cell), minus those already mined. */
  private refreshField(body: Body, focus: THREE.Vector3) {
    const R = body.def.radius;
    const dir = focus.clone().sub(body.pos).normalize();
    const N = Math.max(4, Math.round((R * Math.PI) / 2 / CELL));
    const [face, a, b] = toFace(dir);
    const ci = Math.floor(((a + 1) / 2) * N), cj = Math.floor(((b + 1) / 2) * N);
    const key = `${body.def.id}:${face}:${ci}:${cj}`;
    if (key === this.fieldKey) return;
    this.fieldKey = key;
    this.deposits = [];
    const rich = richness(body.def.id);
    const seed = (body.def.seed * 7919 + face * 104729) | 0;
    const sea = body.terrain!.gen.seaLevel;
    const d = new THREE.Vector3();
    // dark crystals grow within ~3 km of the places of the signal
    const alienHere = this.g.alien.sites.find((s) => s.body === body.def.id && s.dir.angleTo(dir) * R < 3000);
    const up = new THREE.Vector3(0, 1, 0);
    for (let di = -REACH; di <= REACH; di++) {
      for (let dj = -REACH; dj <= REACH; dj++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        if (hash3(i, j, face, seed) > rich.p) continue;
        const dk = `${body.def.id}:${face}:${i}:${j}`;
        if (this.mined.has(dk)) continue;
        fromFace(face, -1 + (2 * (i + 0.15 + 0.7 * hash3(i, j, face, seed + 1))) / N, -1 + (2 * (j + 0.15 + 0.7 * hash3(i, j, face, seed + 2))) / N, d);
        const h = this.g.terrainH(body, d);
        if (sea !== null && h < sea + 0.3) continue; // nothing under the sea
        const kr = hash3(i, j, face, seed + 3);
        const kind: Res = alienHere && hash3(i, j, face, seed + 7) < 0.5 ? 'crystal' : kr < rich.ice ? 'ice' : 'metal';
        const scale = 0.75 + 0.6 * hash3(i, j, face, seed + 4);
        const q = new THREE.Quaternion().setFromUnitVectors(up, d)
          .multiply(new THREE.Quaternion().setFromAxisAngle(up, hash3(i, j, face, seed + 5) * Math.PI * 2));
        this.deposits.push({
          key: dk, kind, body, scale, q,
          off: d.clone().multiplyScalar(R + h - 0.2 * scale),
          amount: (kind === 'ice' ? 3 : kind === 'crystal' ? 1 : 2) + Math.floor(hash3(i, j, face, seed + 6) * (kind === 'crystal' ? 2 : 3)),
        });
      }
    }
    // Europa: the inscription lies under three blocks of ice (the scanner's trial)
    if (body.def.id === 'europa' && this.hasScanner && !this.logsRead.has('frag-europa')) {
      const s = this.g.alien.site('frag-europa')!;
      if (s.dir.angleTo(dir) * R < 3000) {
        EUROPA_ICE.forEach(([x, z], k) => {
          const key = `frag-europa:ice:${k}`;
          if (this.mined.has(key)) return;
          const off = this.g.alien.point(s, x, z).sub(body.pos);
          const n = off.clone().normalize();
          this.deposits.push({ key, kind: 'ice', body, scale: 1.45, q: new THREE.Quaternion().setFromUnitVectors(up, n), off: off.addScaledVector(n, -0.2), amount: 2 });
        });
      }
    }
  }

  private renderObjective() {
    const g = this.g, cw = g.camWorld;
    const o = this.objective();
    const wp = this.objectivePos(o, new THREE.Vector3());
    this.objDist = null;
    if (!wp || g.vision) { css(this.objMarker, 'display', 'none'); return; }
    const focus = g.mode === 'ship' ? g.shipPos : g.playerPos;
    const dist = wp.distanceTo(focus);
    this.objDist = dist;
    const rel = wp.clone().sub(cw);
    if (dist < 6) { css(this.objMarker, 'display', 'none'); return; }
    // behind a world (the other side of the Earth): drawn faint
    let hidden = false;
    for (const b of [g.byId.get('earth')!, g.byId.get('moon')!]) {
      const oc = b.pos.clone().sub(cw), t = oc.dot(rel) / rel.lengthSq();
      if (t > 0 && t < 1 && oc.clone().sub(rel.clone().multiplyScalar(t)).length() < b.def.radius * 0.995) hidden = true;
    }
    // out of view it waits at the edge of the screen, with an arrow towards it
    const where = g.pinMarker(this.objMarker, this.objArrow, rel);
    css(this.objMarker, 'opacity', hidden && where === 'in' ? '0.35' : '1');
    if (g.frame % 6 !== 0) return;
    const al = g.alien.site(o.place);
    const far = al && g.alien.body(al).star !== g.sunBody;
    const name = al ? (far ? `→ ${g.alien.body(al).star.def.name}` : al.name).toUpperCase() : (this.ruins.site(o.place)?.name ?? '').toUpperCase();
    const txt = dist < 1000 ? `${dist.toFixed(0)} m` : dist < 1e6 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist / 1000).toLocaleString('es-ES')} km`;
    this.objLabel.textContent = `${name}  ${txt}`;
  }

  /** why health goes down right now */
  private healthCause(): string | null {
    const g = this.g;
    if (g.mode !== 'foot') return null;
    if (this.oxygen <= 0) return `sin oxígeno · −${NO_O2_DAMAGE * 60}/min`;
    const d = g.suitDrain;
    if (d > 0.06) return `${g.nearest.def.hazard?.text || 'el traje se desgasta'} · −${Math.max(1, Math.round(d * 60))}/min`;
    return null;
  }

  // -------------------------------------------------------------------------
  hud(): SurvivalHud {
    const g = this.g;
    const tr = this.translate;
    let trNear = false;
    if (tr) {
      const s = g.alien.site('frag-proxima')!;
      const [x, z] = SITE_POINTS.monolith.glyph;
      trNear = g.nearest.def.id === 'proxima-b' && g.alien.point(s, x, z).distanceTo(g.playerPos) < 4.5;
    }
    return {
      oxygen: this.oxygen,
      energy: this.energy,
      fuel: this.fuel,
      carried: { ...this.carried },
      stored: { ...this.stored },
      cap: this.mods().cap,
      mining: this.mineTarget ? clamp(this.mineProgress, 0, 1) : 0,
      near: this.nearDeposit ? RES_LABEL[this.nearDeposit.kind] : null,
      crateDist: this.crateDist,
      refining: g.mode === 'ship' ? this.refining : null,
      saved: g.time - this.savedAt < 2,
      emergency: this.emergency,
      nearLog: !!this.prompt && g.mode === 'foot',
      objective: this.objective().text,
      objectiveDist: this.objDist,
      reading: this.reading,
      intro: this.intro,
      hurt: g.hurt,
      shotCost: Math.round((this.weapon === 'dispersor' ? SPREAD_ENERGY : SHOT_ENERGY) * this.mods().energy * 10) / 10,
      sound: this.sfx.enabled,
      prompt: g.mode === 'foot' ? this.prompt : null,
      scanner: this.hasScanner,
      scan: this.scan,
      boss: this.enemies.boss(),
      upgrades: [...this.upgrades],
      ending: this.ending,
      stats: {
        time: this.playTime, deaths: this.deaths,
        logs: [...LOGS, ...BASE_LOGS, ...FRAGMENTS].filter((l) => this.logsRead.has(l.id)).length,
        logsTotal: LOGS.length + BASE_LOGS.length + FRAGMENTS.length,
        caches: this.cachesOpen.size, cachesTotal: CACHES.length,
        mementos: this.mementos.size, mementosTotal: MEMENTOS.length,
      },
      flying: g.mode === 'ship' && !g.landed,
      hunters: this.enemies.tension() >= 0.7 && g.mode === 'ship',
      vega: this.vega.hud(),
      hitT: this.enemies.hitT,
      hitHp: this.enemies.hitHp,
      weapon: this.weapon,
      dispersor: this.hasDispersor,
      medkits: this.medkits,
      mementos: this.mementos.size,
      mementosTotal: MEMENTOS.length,
      healthCause: this.healthCause(),
      beacons: this.beacons,
      beaconLeft: this.beacon && this.beacon.body === g.nearest.def.id ? this.beacon.t : null,
      translate: tr ? { k: clamp(tr.t / TRANSLATE_TIME, 0, 1), near: trNear } : null,
      deathNote: this.deathNote,
    };
  }

  // -------------------------------------------------------------------------
  // Saved game (localStorage). Always restored aboard the ship.

  /** not now: a game continued from here would bring back the same death (or the dead pilot) */
  private unsafe() {
    const g = this.g;
    if (g.dead) return true;
    // (low health, hull or air are not a reason: a loaded game always wakes up aboard, with at least 25 of each)
    if (g.nearest.def.kind === 'gas' && g.pressureNow > 25) return true;
    const st = g.sunBody;
    return g.shipPos.distanceTo(st.pos) < st.def.radius * 3;
  }

  save() {
    const g = this.g;
    if (!g.started || g.gameMode !== 'survival') return;
    this.saveT = 0;
    // never write a broken position (it would bring the game back inside a star), nor a moment of danger
    if (![g.shipPos.x, g.shipPos.y, g.shipPos.z, g.shipQ.x, g.shipQ.w].every(Number.isFinite)) return;
    if (this.unsafe()) return;
    let body = g.bodies[0], bd = Infinity;
    for (const b of g.bodies) {
      const d = g.shipPos.distanceTo(b.pos) - b.def.radius;
      if (d < bd) { bd = d; body = b; }
    }
    const off = g.shipPos.clone().sub(body.pos);
    const foot = g.mode === 'foot' ? g.playerPos.clone().sub(g.nearest.pos) : null;
    const s: SurvivalSave = {
      v: 1, saved: Date.now(), body: body.def.id, off: [off.x, off.y, off.z],
      q: g.shipQ.toArray() as [number, number, number, number],
      landed: g.landed || g.mode === 'foot',
      hull: Math.max(g.hull, 25), health: Math.max(g.suit, 25), oxygen: Math.max(this.oxygen, 25), energy: this.energy, fuel: this.fuel,
      carried: this.carried, stored: this.stored, mined: [...this.mined], crate: this.crate,
      target: g.target?.def.id ?? null, deaths: this.deaths, playTime: this.playTime,
      logs: [...this.logsRead],
      destroyed: [...this.enemies.destroyed],
      caches: [...this.cachesOpen],
      upgrades: [...this.upgrades],
      ended: this.ended,
      loot: [...this.loot.opened],
      mementos: [...this.mementos],
      medkits: this.medkits,
      weapon: this.weapon,
      vega: [...this.vega.once],
      footOff: foot && g.nearest === body ? [foot.x, foot.y, foot.z] : undefined,
      guardianHp: this.enemies.guardianHp,
      lootLeft: [...this.loot.left.entries()].filter(([id]) => this.loot.spots.has(id) || id.startsWith('crate:') || id.startsWith('bunker:')),
      visited: [...this.visited],
      beacons: this.beacons,
      planted: this.planted,
      lastHoldLoss: this.lastHoldLoss - this.playTime,
      marks: [...this.marks],
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); this.savedAt = g.time; } catch { /* storage full or unavailable */ }
  }

  /** restore everything but the ship's position (Game.restoreSurvival places it) */
  apply(s: SurvivalSave) {
    this.oxygen = s.oxygen; this.energy = s.energy; this.fuel = s.fuel;
    this.carried = fixCargo(s.carried); this.stored = fixCargo(s.stored);
    this.mined = new Set(s.mined);
    this.crate = s.crate ? { ...s.crate, cargo: fixCargo(s.crate.cargo) } : null;
    this.deaths = s.deaths; this.playTime = s.playTime;
    this.lastProgress = this.playTime;
    this.logsRead = new Set(s.logs ?? []);
    this.enemies.destroyed = new Set(s.destroyed ?? []);
    if (typeof s.guardianHp === 'number' && Number.isFinite(s.guardianHp)) this.enemies.guardianHp = s.guardianHp;
    this.cachesOpen = new Set(s.caches ?? []);
    this.upgrades = new Set((s.upgrades ?? []) as UpgradeId[]);
    this.ended = !!s.ended;
    this.loot.opened = new Set(s.loot ?? []);
    this.loot.left = new Map(s.lootLeft ?? []);
    this.mementos = new Set(s.mementos ?? []);
    this.medkits = s.medkits ?? 1;
    this.weapon = s.weapon === 'dispersor' && this.upgrades.has('dispersor') ? 'dispersor' : 'rifle';
    this.vega.once = new Set(s.vega ?? []);
    this.visited = new Set(s.visited ?? []);
    this.beacons = s.beacons ?? 0;
    this.planted = !!s.planted;
    this.lastHoldLoss = this.playTime + (s.lastHoldLoss ?? -1e9);
    this.marks = new Set(s.marks ?? []);
    for (let k = 0; k < 3; k++) this.g.alien.marsLit[k] = this.marks.has(`mars-${k}`) ? 1 : 0;
    // a game saved before the epilogue existed: its Esperanza shelter was opened without the seeds
    if (this.loot.opened.has('bunker:esperanza') && !this.mementos.has('m-semillas')) this.mementos.add('m-semillas');
    // saved on foot: you wake up aboard, and what you carried is where you stood (no free trip home)
    if (s.footOff && s.footOff.every(Number.isFinite) && this.total(this.carried) > 0) {
      const prev = this.crate ? this.crate.cargo : emptyCargo();
      const cargo = emptyCargo();
      for (const k of RES_KINDS) cargo[k] = this.carried[k] + prev[k];
      this.crate = { body: s.body, off: s.footOff, cargo };
      this.carried = emptyCargo();
      this.g.note('Despiertas a bordo. Lo que llevabas quedó donde estabas: sigue la señal ◇');
    }
  }

  // -------------------------------------------------------------------------
  // Things R does: recordings, the artefact, the inscriptions, the caches
  private interactables(): Interactable[] {
    const g = this.g, b = g.nearest, out: Interactable[] = [];
    if (b.def.id === 'earth') {
      for (const l of LOGS) {
        const s = this.ruins.site(l.site);
        if (s) out.push({ pos: s.logPos.clone().add(b.pos), prompt: 'escuchar el registro', act: () => this.openLog(l) });
      }
      // the epilogue: the seeds, by the beacon, in the sun
      const es = this.ruins.site('esperanza');
      if (es && this.ended && !this.planted && this.mementos.has('m-semillas')) {
        out.push({ pos: es.logPos.clone().add(b.pos).addScaledVector(es.east, 1.6), prompt: 'plantar las semillas', act: () => { this.planted = true; this.openLog(EPILOGUE); } });
      }
    }
    for (const s of g.alien.sites) {
      if (s.body !== b.def.id || !b.terrain) continue;
      if (s.kind === 'base') {
        const pts = SITE_POINTS.base;
        BASE_LOGS.forEach((l) => {
          const [x, z] = l.site === 't1' ? pts.t1 : l.site === 't2' ? pts.t2 : pts.artefact;
          out.push({ pos: g.alien.point(s, x, z), prompt: l.site === 'artefact' ? 'examinar el artefacto' : 'escuchar el registro', act: () => this.openLog(l) });
        });
      } else if (s.kind === 'monolith') {
        const f = FRAGMENTS.find((x) => x.site === s.id);
        if (!f) continue;
        const [x, z] = SITE_POINTS.monolith.glyph;
        const pos = g.alien.point(s, x, z);
        if (!this.hasScanner) {
          out.push({ pos, prompt: 'tocar la piedra', act: () => g.note('Las líneas brillan, pero no entiendes nada. Quizá con el escáner de Tsiolkovsky…') });
          continue;
        }
        if (this.logsRead.has(f.id)) { out.push({ pos, prompt: 'leer la inscripción', act: () => this.openLog(f) }); continue; }
        if (s.id === 'frag-mars') {
          const lit = MARS_STONES.filter((_, k) => this.marks.has(`mars-${k}`)).length;
          out.push({
            pos, prompt: lit < 3 ? `leer la inscripción (piedras encendidas ${lit}/3)` : 'leer la inscripción',
            act: () => { if (lit < 3) { g.note('La inscripción está incompleta: tres piedras del anillo tienen las líneas apagadas. Ilumínalas con la linterna ({KeyF})'); this.vega.say(VEGA.marsStones, 'marsStones', { once: true }); } else this.openLog(f); },
          });
        } else if (s.id === 'frag-europa') {
          // under the ice: dig it out first (the blocks are mined like any ice; then it can be read)
          const left = EUROPA_ICE.filter((_, k) => !this.mined.has(`frag-europa:ice:${k}`)).length;
          if (left === 0) out.push({ pos, prompt: 'leer la inscripción', act: () => this.openLog(f) });
          else if (pos.distanceTo(g.playerPos) < 30) this.vega.say(VEGA.europaIce, 'europaIce', { once: true });
        } else if (s.id === 'frag-proxima') {
          if (!this.translate) {
            out.push({
              pos, prompt: 'traducir la inscripción con el escáner (15 s)',
              act: () => {
                this.translate = { t: 0 };
                this.vega.say(VEGA.proximaScan, 'proximaScan', { once: true });
                g.note('El escáner traduce: quédate cerca de la piedra');
                if (!this.ended) this.enemies.ambush('night', 3);
              },
            });
          }
        } else out.push({ pos, prompt: 'leer la inscripción con el escáner', act: () => this.openLog(f) });
      }
    }
    // supply crates, shelters, wrecks
    for (const s of this.loot.near(g.playerPos, READ_RANGE + 0.6)) {
      out.push({ pos: this.loot.usePos(s), prompt: s.kind === 'bunker' ? 'entrar en el refugio' : s.kind === 'wreck' ? 'registrar los restos' : 'abrir la caja', act: () => this.openSpot(s) });
    }
    if (this.hasScanner) {
      for (const c of CACHES) {
        if (c.body !== b.def.id || this.cachesOpen.has(c.id) || !b.terrain) continue;
        out.push({ pos: this.cachePos(c, b), prompt: 'abrir el alijo', act: () => this.openCache(c) });
      }
    }
    return out;
  }

  /** a cache's place on its world (computed once: the worlds never move) */
  private cachePos(c: CacheDef, b: Body) {
    let off = this.cachePosCache.get(c.id);
    if (!off) {
      const d = new THREE.Vector3(...c.dir).normalize();
      off = d.multiplyScalar(b.def.radius + this.g.terrainH(b, d));
      this.cachePosCache.set(c.id, off);
    }
    return off.clone().add(b.pos);
  }

  private openCache(c: CacheDef) {
    const g = this.g;
    this.cachesOpen.add(c.id);
    const up = UPGRADES.find((u) => u.id === c.upgrade)!;
    const had = this.upgrades.has(c.upgrade);
    this.upgrades.add(c.upgrade);
    // already bought: the parts are worth what it cost (back to the hold)
    if (had) {
      this.stored.metal += up.metal;
      this.stored.crystal += up.crystal;
      g.note(`Alijo abierto: piezas de ${up.name}. Ya la tenías: +${up.metal} metal y +${up.crystal} cristal a la bodega`);
    } else g.note(`Alijo abierto: ${up.name} instalada`);
    this.gain('crystal', 4, 'del alijo');
    this.sfx.play('chime');
    if (c.log) this.openLog(c.log);
    else this.save();
  }

  /** the caches only exist for the scanner (and are drawn when close) */
  private renderCaches() {
    const g = this.g, b = g.nearest, cw = g.camWorld;
    this.scan = null;
    let best = Infinity, bestPos: THREE.Vector3 | null = null;
    const focus = g.mode === 'ship' ? g.shipPos : g.playerPos;
    for (const c of CACHES) {
      let m = this.cacheMeshes.get(c.id);
      const show = this.hasScanner && !this.cachesOpen.has(c.id) && c.body === b.def.id && !!b.terrain;
      if (!show) { if (m) m.visible = false; continue; }
      const pos = this.cachePos(c, b);
      const dist = pos.distanceTo(focus);
      if (dist < best) { best = dist; bestPos = pos; }
      if (!m && dist < 3000) {
        m = new THREE.Group();
        const box = new THREE.Mesh(this.cacheBox, this.cacheMat);
        box.castShadow = true;
        const strip = new THREE.Mesh(this.cacheStrip, this.cacheGlow);
        strip.position.y = 0.42;
        m.add(box, strip);
        g.scene.add(m);
        this.cacheMeshes.set(c.id, m);
      }
      if (m) {
        m.visible = dist < 3000;
        m.position.copy(pos).sub(cw);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pos.clone().sub(b.pos).normalize());
      }
    }
    // the scanner's needle: bearing of the hidden cache relative to the view
    if (bestPos && best < 2e7) {
      const v = bestPos.clone().sub(cw).applyQuaternion(g.camera.quaternion.clone().invert());
      this.scan = { dist: best, angle: (Math.atan2(v.x, -v.z) * 180) / Math.PI };
    }
  }

  static load(): SurvivalSave | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as SurvivalSave;
      return s && s.v === 1 ? s : null;
    } catch { return null; }
  }
  static clear() {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
  }
}

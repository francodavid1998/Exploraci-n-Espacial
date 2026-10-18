import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from './Game';
import { hash3, mulberry32, Noise3, clamp } from './noise';
import { LOGS, objectiveAt, type LogEntry, type Objective } from './story';

/**
 * Survival mode, phase 1: life support (oxygen, battery, health), ship fuel, mining
 * ice and metal on the surface of rocky worlds, a mild death penalty (you wake up in
 * the ship; what you carried stays where you fell) and saved games.
 * Phase 2: Earth in ruins, the survivors' recordings and the objective they lead to.
 *
 * Realistic exploration never creates this object, so nothing here can change it.
 */
export type GameMode = 'explore' | 'survival';
export type Res = 'ice' | 'metal';
export const RES_LABEL: Record<Res, string> = { ice: 'hielo', metal: 'metal' };

type Body = Game['bodies'][number];
type Cargo = Record<Res, number>;

/** what the suit can carry (units); the ship's hold has no limit */
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
const JUMP_COST = 2; // lighting the pulse engine
const ICE_FUEL = 5; // fuel from one unit of ice
const METAL_HULL = 8; // hull repaired with one unit of metal
const START_FUEL = 60;

/** deposits: one chance per 50 m cell of the world's surface */
const CELL = 50;
const REACH = 5; // cells around the player that may show a deposit (±275 m)
const MAX_DEPOSITS = 128;
const SAVE_KEY = 'helios-survival-1';
const AUTOSAVE = 20; // seconds

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
}

/** How rich each world is: chance of a deposit per cell, and the share of ice among them. */
function richness(id: string): { p: number; ice: number } {
  switch (id) {
    case 'europa': case 'ganymede': case 'callisto': case 'titan': case 'triton':
    case 'trappist-1f': case 'trappist-1g': case 'trappist-1h':
      return { p: 0.1, ice: 0.85 };
    case 'mercury': case 'venus': case 'io': case 'trappist-1b': case 'trappist-1c': case 'proxima-d':
      return { p: 0.1, ice: 0.08 };
    case 'mars': return { p: 0.1, ice: 0.4 };
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

export class Survival {
  oxygen = 100;
  energy = 100;
  fuel = START_FUEL;
  carried: Cargo = { ice: 0, metal: 0 };
  stored: Cargo = { ice: 0, metal: 0 };
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
  /** Earth's ruins belong to the world (both modes); survival places its recordings in them */
  private get ruins() { return this.g.ruins; }

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
  private crateLabel: HTMLDivElement;
  private crateDist: number | null = null;
  private nearLog: LogEntry | null = null;
  private objMarker: HTMLDivElement;
  private objLabel: HTMLDivElement;
  private objDist: number | null = null;

  constructor(g: Game, markerLayer: HTMLElement) {
    this.g = g;
    const ice = new THREE.MeshStandardMaterial({ color: 0xcfe8ff, roughness: 0.18, metalness: 0, emissive: 0x0b1c2b, flatShading: true });
    const ore = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.55, flatShading: true });
    this.meshes = { ice: new THREE.InstancedMesh(iceGeo(), ice, MAX_DEPOSITS), metal: new THREE.InstancedMesh(oreGeo(), ore, MAX_DEPOSITS) };
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
    this.crateMarker = document.createElement('div');
    this.crateMarker.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;display:none;white-space:nowrap;font-family:ui-monospace,monospace;';
    const dot = document.createElement('div');
    dot.style.cssText = 'width:12px;height:12px;border:1.5px solid #7dd3fc;transform:translate(-50%,-50%) rotate(45deg);position:absolute;left:0;top:0;box-sizing:border-box;';
    this.crateLabel = document.createElement('div');
    this.crateLabel.style.cssText = 'position:absolute;left:12px;top:-7px;font-size:11px;color:#7dd3fc;text-shadow:0 0 4px #000;letter-spacing:.05em;';
    this.crateMarker.append(dot, this.crateLabel);
    markerLayer.appendChild(this.crateMarker);
    // the objective: an amber diamond on the place to go
    this.objMarker = document.createElement('div');
    this.objMarker.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;display:none;white-space:nowrap;font-family:ui-monospace,monospace;';
    const od = document.createElement('div');
    od.style.cssText = 'width:13px;height:13px;border:2px solid #fbbf24;transform:translate(-50%,-50%) rotate(45deg);position:absolute;left:0;top:0;box-sizing:border-box;';
    this.objLabel = document.createElement('div');
    this.objLabel.style.cssText = 'position:absolute;left:13px;top:-7px;font-size:11px;color:#fcd34d;text-shadow:0 0 4px #000;letter-spacing:.05em;';
    this.objMarker.append(od, this.objLabel);
    markerLayer.appendChild(this.objMarker);
    window.addEventListener('pagehide', this.onHide);
  }

  /** the next recording to find (in story order), or the far side of the Moon once all are heard */
  objective(): Objective {
    const i = LOGS.findIndex((l) => !this.logsRead.has(l.id));
    return objectiveAt(i < 0 ? LOGS.length : i);
  }

  /** world position of the objective, or null when it is not in this star system */
  private objectivePos(o: Objective, out: THREE.Vector3): THREE.Vector3 | null {
    const g = this.g;
    if (o.place === 'tsiolkovsky') {
      const moon = g.byId.get('moon')!, earth = g.byId.get('earth')!;
      if (moon.star !== g.sunBody) return null;
      // the crater lies on the far side, 20 degrees south of the point facing away from Earth
      const away = moon.pos.clone().sub(earth.pos).normalize();
      const d = away.multiplyScalar(Math.cos(0.35)).add(new THREE.Vector3(0, -Math.sin(0.35), 0)).normalize();
      return out.copy(moon.pos).addScaledVector(d, moon.def.radius + g.terrainH(moon, d));
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
    const first = !this.logsRead.has(l.id);
    this.logsRead.add(l.id);
    if (first) {
      this.g.note(`Registro guardado: ${l.title} (${this.logsRead.size}/${LOGS.length}). Puedes releerlo en el mapa`);
      this.g.note(`Nuevo objetivo: ${this.objective().text}`);
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
  }

  private total(c: Cargo) { return c.ice + c.metal; }
  private cargoText(c: Cargo) {
    const p: string[] = [];
    if (c.ice) p.push(`${c.ice} hielo`);
    if (c.metal) p.push(`${c.metal} metal`);
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
      else this.oxygen = Math.max(0, this.oxygen - dt * O2_RATE * (run ? O2_RUN : 1));
      if (this.oxygen <= 0) {
        g.suit -= dt * NO_O2_DAMAGE;
        g.warnings.push('SIN OXÍGENO · VUELVE A LA NAVE');
        if (g.suit <= 0) g.die('Te quedaste sin oxígeno lejos de la nave.');
      } else if (this.oxygen < 25) g.warnings.push(`OXÍGENO ${this.oxygen.toFixed(0)}%`);
      // dead (out of air, or a fall or hazard earlier this frame): the case just dropped stays there
      if (g.dead) return;
      // battery: the flashlight drains it, the suit's panels charge it in sunlight
      const sunlit = clamp(g.light.intensity / 3.3, 0, 1);
      this.energy = clamp(this.energy + dt * (SOLAR_CHARGE * sunlit - (g.lightsOn ? LAMP_DRAIN : 0)), 0, 100);
      if (this.energy <= 0 && g.lightsOn) {
        g.lightsOn = false;
        g.note('Batería agotada: la linterna se apagó. Se recarga al sol o en la nave');
      }
      this.updateMining(dt);
      this.updateCrate();
    } else {
      // aboard: the ship's life support refills the suit and treats you
      this.oxygen = Math.min(100, this.oxygen + dt * 20);
      this.energy = Math.min(100, this.energy + dt * 4);
      g.suit = Math.min(100, g.suit + dt * 2);
      if (this.total(this.carried) > 0) {
        g.note(`Descargado en la bodega: ${this.cargoText(this.carried)}`);
        this.stored.ice += this.carried.ice;
        this.stored.metal += this.carried.metal;
        this.carried = { ice: 0, metal: 0 };
      }
      this.updateRefinery(dt);
      if (this.fuel < 15 && !g.warp) g.warnings.push(`COMBUSTIBLE ${this.fuel.toFixed(0)}%`);
      this.mineProgress = 0;
      this.mineTarget = null;
      this.nearDeposit = null;
    }
    // boarding the ship is a good moment to save
    if (this.wasFoot && !foot) this.save();
    this.wasFoot = foot;
    this.saveT += dt;
    if (this.saveT > AUTOSAVE) this.save();
  }

  canLight() { return this.energy > 1; }

  private updateMining(dt: number) {
    const g = this.g;
    const p = g.playerPos;
    // a survivor's recording within reach: R plays it
    this.nearLog = null;
    if (g.nearest.def.id === 'earth') {
      const E = g.nearest;
      for (const l of LOGS) {
        const s = this.ruins.site(l.site);
        if (s && s.logPos.clone().add(E.pos).distanceTo(p) < READ_RANGE) { this.nearLog = l; break; }
      }
    }
    if (this.nearLog) {
      if (g.pressed.has('KeyR')) this.openLog(this.nearLog);
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
    if (this.total(this.carried) >= CARGO_CAP) {
      if (g.pressed.has('KeyR')) g.note(`Carga llena (${CARGO_CAP}): vuelve a la nave para descargarla`);
      return;
    }
    if (this.energy < MINE_ENERGY) {
      if (g.pressed.has('KeyR')) g.note('Batería insuficiente para extraer: recárgala al sol o en la nave');
      return;
    }
    if (this.mineTarget !== best) { this.mineTarget = best; this.mineProgress = 0; }
    this.mineProgress += dt / MINE_TIME;
    if (this.mineProgress >= 1) {
      const room = CARGO_CAP - this.total(this.carried);
      const got = Math.min(best.amount, room);
      this.carried[best.kind] += got;
      this.energy -= MINE_ENERGY;
      this.mined.add(best.key);
      if (this.mined.size > 4000) this.mined.delete(this.mined.values().next().value!);
      this.deposits.splice(this.deposits.indexOf(best), 1);
      g.note(`+${got} ${RES_LABEL[best.kind]} · carga ${this.total(this.carried)}/${CARGO_CAP}`);
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
    const room = CARGO_CAP - this.total(this.carried);
    if (room <= 0) { if (g.pressed.has('KeyR')) g.note('Carga llena: no puedes recoger tus cosas'); return; }
    const take: Cargo = { ice: 0, metal: 0 };
    let left = room;
    for (const k of ['metal', 'ice'] as Res[]) {
      const n = Math.min(c.cargo[k], left);
      take[k] = n; c.cargo[k] -= n; left -= n;
    }
    this.carried.ice += take.ice;
    this.carried.metal += take.metal;
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

  /** Pulse engine ignition. 'go' = jump, 'emergency' = jump on the reserve towards the nearest world, 'no' = stay. */
  jumpStart(): 'go' | 'emergency' | 'no' {
    const g = this.g;
    if (this.fuel >= JUMP_COST + 1) {
      this.fuel -= JUMP_COST;
      this.emergency = false;
      return 'go';
    }
    const near = g.nearest;
    const alt = g.shipPos.distanceTo(near.pos) - near.def.radius;
    if (near.def.kind === 'rocky' && alt < near.def.radius * 3) {
      g.note(`Sin combustible para el salto: aterriza en ${near.def.name} y extrae hielo (R)`);
      return 'no';
    }
    const w = this.nearestWorld(g.shipPos);
    if (!w) { g.note('Sin combustible para el salto'); return 'no'; }
    this.beginEmergency(w);
    return 'emergency';
  }

  private nearestWorld(p: THREE.Vector3): Body | null {
    let best: Body | null = null, bd = Infinity;
    for (const b of this.g.bodies) {
      if (b.def.kind !== 'rocky' || b.star !== this.g.sunBody || b.def.radius < 100e3) continue;
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
    if (this.emergency) return;
    const rate = 0.25 + 0.12 * Math.max(0, Math.log10(speed / 1e6));
    this.fuel = Math.max(0, this.fuel - rate * dt);
    if (this.fuel <= 0) {
      const w = this.nearestWorld(this.g.shipPos);
      if (w) this.beginEmergency(w);
    }
  }
  warpEnded() { this.emergency = false; }

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
    const g = this.g;
    this.deaths++;
    if (onFoot) {
      if (this.total(this.carried) > 0) {
        const off = g.playerPos.clone().sub(g.nearest.pos);
        const keep = this.crate && this.crate.body === g.nearest.def.id ? this.crate.cargo : { ice: 0, metal: 0 };
        // a second death before recovering them: everything is kept, in the newest place
        const old = this.crate && this.crate.body !== g.nearest.def.id ? this.crate.cargo : { ice: 0, metal: 0 };
        this.crate = {
          body: g.nearest.def.id, off: [off.x, off.y, off.z],
          cargo: { ice: this.carried.ice + keep.ice + old.ice, metal: this.carried.metal + keep.metal + old.metal },
        };
        this.carried = { ice: 0, metal: 0 };
      }
    } else {
      // the wreck: part of the hold is lost
      this.stored.ice = Math.floor(this.stored.ice * 0.7);
      this.stored.metal = Math.floor(this.stored.metal * 0.7);
    }
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
      g.note('Nave reconstruida en órbita con lo que quedaba: casco al 40% y parte de la bodega perdida');
    } else {
      g.suit = 50;
      g.note(this.crate ? 'Despiertas a bordo. Lo que llevabas quedó donde caíste: sigue la señal ◇' : 'Despiertas a bordo de la nave');
    }
    this.save();
  }

  // -------------------------------------------------------------------------
  // Drawing (every frame, also while paused)

  render() {
    const g = this.g;
    const body = g.nearest;
    const cw = g.camWorld;
    this.ruins.updateTerminals(this.logsRead, (site) => LOGS.find((l) => l.site === site)?.id);
    this.renderObjective();
    const focus = g.mode === 'ship' ? g.shipPos : g.playerPos;
    const near = body.def.kind === 'rocky' && !!body.terrain && g.altitude < 2500 && !g.warp;
    if (near) this.refreshField(body, focus);
    else if (this.fieldKey) { this.fieldKey = ''; this.deposits = []; }
    const counts: Record<Res, number> = { ice: 0, metal: 0 };
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
    for (const k of ['ice', 'metal'] as Res[]) {
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
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion);
      if (g.vision || rel.dot(fwd) <= 0) { this.crateMarker.style.display = 'none'; return; }
      const v = rel.clone().project(g.camera);
      const lay = this.crateMarker.parentElement!;
      const sx = (v.x * 0.5 + 0.5) * lay.clientWidth, sy = (-v.y * 0.5 + 0.5) * lay.clientHeight;
      this.crateMarker.style.display = Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 ? 'block' : 'none';
      this.crateMarker.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      const txt = dist < 1000 ? `${dist.toFixed(0)} m` : dist < 1e6 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist / 1000).toLocaleString('es-ES')} km`;
      this.crateLabel.textContent = `TUS COSAS  ${txt}`;
    } else {
      this.crateMesh.visible = false;
      this.crateMarker.style.display = 'none';
    }
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
        const kind: Res = hash3(i, j, face, seed + 3) < rich.ice ? 'ice' : 'metal';
        const scale = 0.75 + 0.6 * hash3(i, j, face, seed + 4);
        const q = new THREE.Quaternion().setFromUnitVectors(up, d)
          .multiply(new THREE.Quaternion().setFromAxisAngle(up, hash3(i, j, face, seed + 5) * Math.PI * 2));
        this.deposits.push({
          key: dk, kind, body, scale, q,
          off: d.clone().multiplyScalar(R + h - 0.2 * scale),
          amount: (kind === 'ice' ? 3 : 2) + Math.floor(hash3(i, j, face, seed + 6) * 3),
        });
      }
    }
  }

  private renderObjective() {
    const g = this.g, cw = g.camWorld;
    const o = this.objective();
    const wp = this.objectivePos(o, new THREE.Vector3());
    this.objDist = null;
    if (!wp || g.vision) { this.objMarker.style.display = 'none'; return; }
    const focus = g.mode === 'ship' ? g.shipPos : g.playerPos;
    const dist = wp.distanceTo(focus);
    this.objDist = dist;
    const rel = wp.clone().sub(cw);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion);
    if (rel.dot(fwd) <= 0 || dist < 6) { this.objMarker.style.display = 'none'; return; }
    // behind a world (the other side of the Earth): drawn faint
    let hidden = false;
    for (const b of [g.byId.get('earth')!, g.byId.get('moon')!]) {
      const oc = b.pos.clone().sub(cw), t = oc.dot(rel) / rel.lengthSq();
      if (t > 0 && t < 1 && oc.clone().sub(rel.clone().multiplyScalar(t)).length() < b.def.radius * 0.995) hidden = true;
    }
    const v = rel.clone().project(g.camera);
    const lay = this.objMarker.parentElement!;
    const inView = Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
    this.objMarker.style.display = inView ? 'block' : 'none';
    if (!inView) return;
    this.objMarker.style.transform = `translate(${((v.x * 0.5 + 0.5) * lay.clientWidth).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * lay.clientHeight).toFixed(1)}px)`;
    this.objMarker.style.opacity = hidden ? '0.35' : '1';
    const name = o.place === 'tsiolkovsky' ? 'BASE TSIOLKOVSKY' : (this.ruins.site(o.place)?.name ?? '').toUpperCase();
    const txt = dist < 1000 ? `${dist.toFixed(0)} m` : dist < 1e6 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist / 1000).toLocaleString('es-ES')} km`;
    this.objLabel.textContent = `${name}  ${txt}`;
  }

  // -------------------------------------------------------------------------
  hud(): SurvivalHud {
    return {
      oxygen: this.oxygen,
      energy: this.energy,
      fuel: this.fuel,
      carried: { ...this.carried },
      stored: { ...this.stored },
      cap: CARGO_CAP,
      mining: this.mineTarget ? clamp(this.mineProgress, 0, 1) : 0,
      near: this.nearDeposit ? RES_LABEL[this.nearDeposit.kind] : null,
      crateDist: this.crateDist,
      refining: this.g.mode === 'ship' ? this.refining : null,
      saved: this.g.time - this.savedAt < 2,
      emergency: this.emergency,
      nearLog: !!this.nearLog && this.g.mode === 'foot',
      objective: this.objective().text,
      objectiveDist: this.objDist,
      reading: this.reading,
      intro: this.intro,
    };
  }

  // -------------------------------------------------------------------------
  // Saved game (localStorage). Always restored aboard the ship.

  save() {
    const g = this.g;
    if (!g.started || g.gameMode !== 'survival') return;
    this.saveT = 0;
    let body = g.bodies[0], bd = Infinity;
    for (const b of g.bodies) {
      const d = g.shipPos.distanceTo(b.pos) - b.def.radius;
      if (d < bd) { bd = d; body = b; }
    }
    const off = g.shipPos.clone().sub(body.pos);
    const s: SurvivalSave = {
      v: 1, saved: Date.now(), body: body.def.id, off: [off.x, off.y, off.z],
      q: g.shipQ.toArray() as [number, number, number, number],
      landed: g.landed || g.mode === 'foot',
      hull: g.hull, health: Math.max(g.suit, 1), oxygen: this.oxygen, energy: this.energy, fuel: this.fuel,
      carried: this.carried, stored: this.stored, mined: [...this.mined], crate: this.crate,
      target: g.target?.def.id ?? null, deaths: this.deaths, playTime: this.playTime,
      logs: [...this.logsRead],
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); this.savedAt = g.time; } catch { /* storage full or unavailable */ }
  }

  /** restore everything but the ship's position (Game.restoreSurvival places it) */
  apply(s: SurvivalSave) {
    this.oxygen = s.oxygen; this.energy = s.energy; this.fuel = s.fuel;
    this.carried = { ...s.carried }; this.stored = { ...s.stored };
    this.mined = new Set(s.mined);
    this.crate = s.crate;
    this.deaths = s.deaths; this.playTime = s.playTime;
    this.logsRead = new Set(s.logs ?? []);
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

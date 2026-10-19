import * as THREE from 'three';
import type { Game } from './Game';
import type { TerrainGen } from './bodies';
import { patchTerrainMaterial, type TerrainUniforms } from './shaders';
import { mulberry32, Noise3 } from './noise';

/**
 * The ruined cities of Earth (both game modes): dead cities, towns and a mountain
 * observatory placed on the procedural continents (the same places every game), built
 * only when the player comes within a few dozen kilometres, drawn with the same light and
 * haze as the ground under them, and solid to walk around. Survival mode adds the
 * survivors' recordings (terminals) in the story's places.
 */
type Body = Game['bodies'][number];

export interface RuinSite {
  id: string;
  name: string;
  kind: 'city' | 'station';
  /** direction from Earth's centre */
  dir: THREE.Vector3;
  /** terrain height at the centre (m) */
  ground: number;
  radius: number;
  seed: number;
  /** the recording (terminal), relative to Earth's centre */
  logPos: THREE.Vector3;
  east: THREE.Vector3;
  north: THREE.Vector3;
}

interface Building { x: number; z: number; hx: number; hz: number; yaw: number; base: number; h: number; broken: boolean }

interface City {
  site: RuinSite;
  group: THREE.Group;
  buildings: Building[];
  /** building indices by 64 m cell (collisions) */
  grid: Map<number, number[]>;
  /** marks of the buildings already looked at in the current search */
  seen: Uint32Array;
  stamp: number;
  disposables: { dispose(): void }[];
  /** small rubble is only drawn up to RUBBLE_DIST (site-local tile centres) */
  rubble: { mesh: THREE.Object3D; x: number; z: number }[];
  /** the story's shelter (both modes): where it is, its door and its lamp */
  bunker: { off: THREE.Vector3; facing: THREE.Vector3; lamp: THREE.MeshBasicMaterial; door: THREE.Mesh } | null;
}
/** the story's cities have a concrete shelter (survival opens it) */
const _r1 = new THREE.Vector3(), _r2 = new THREE.Vector3(), _r3 = new THREE.Vector3();
const _loc = { u: 0, v: 0, pu: 0, pv: 0, cs: 1, sn: 0 };
/** a 64 m grid cell as one number */
const cellKey = (x: number, z: number) => (x + 2048) * 4096 + (z + 2048);
const BUNKER_SITES = ['esperanza', 'alba', 'meridiano', 'telmo', 'cumbre'];
/** instances are grouped in tiles this big, so what the camera (and the shadow) does not see is skipped */
const TILE = 300;
const RUBBLE_DIST = 1500;
/** feet this close under the top of a flat roof stand on it (walls do not push them) */
const ROOF_BAND = 1.2;
const BUNKER_GEO = {
  body: new THREE.BoxGeometry(4, 2.6, 3.6).translate(0, 1.3, 0),
  door: new THREE.PlaneGeometry(1.1, 1.9),
  lamp: new THREE.BoxGeometry(0.35, 0.18, 0.18),
};
const BUNKER_MAT = {
  concrete: new THREE.MeshStandardMaterial({ color: 0x5b5a56, roughness: 0.95, metalness: 0 }),
  door: new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.6, metalness: 0.5 }),
  dark: new THREE.MeshBasicMaterial({ color: 0x030303 }),
};

/** the story's places, in the order the recordings lead through them (the first one lies under the ship's start) */
const SITE_DEFS: { id: string; name: string; kind: 'city' | 'station'; radius: number }[] = [
  { id: 'esperanza', name: 'Nueva Esperanza', kind: 'city', radius: 650 },
  { id: 'alba', name: 'Puerto Alba', kind: 'city', radius: 520 },
  { id: 'meridiano', name: 'Ciudad Meridiano', kind: 'city', radius: 760 },
  { id: 'telmo', name: 'San Telmo', kind: 'city', radius: 480 },
  { id: 'cumbre', name: 'Observatorio Cumbre', kind: 'station', radius: 90 },
];
/** more ruins all over the continents, to find while exploring */
const TOWNS = [
  'Villa Serena', 'Puerto Gris', 'Altos del Norte', 'Ciudad Ocaso', 'San Rafael del Valle', 'Bahía Quieta', 'Las Torres',
  'Nueva Castilla', 'Valle Hondo', 'Monte Claro', 'Ribera Sur', 'Puerto Nadir', 'Campo Abierto', 'Santa Lucía', 'Costa Brava Vieja', 'Ciudad Arcos',
];
const BUILD_DIST = 45e3, DROP_DIST = 90e3;
const CELL = 64;

function tangents(up: THREE.Vector3) {
  const ref = Math.abs(up.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const east = new THREE.Vector3().crossVectors(ref, up).normalize();
  const north = new THREE.Vector3().crossVectors(east, up).normalize(); // east x up = north: a right-handed local frame
  return { east, north };
}

/** unit direction a distance (x east, z north) metres from `up` along the ground */
function offsetDir(up: THREE.Vector3, east: THREE.Vector3, north: THREE.Vector3, R: number, x: number, z: number, out = new THREE.Vector3()) {
  return out.copy(up).multiplyScalar(R).addScaledVector(east, x).addScaledVector(north, z).normalize();
}

/** Places the sites on land: flat lowlands near the start (the first city is under the ship), a coast, mountains. */
function findSites(gen: TerrainGen, R: number, start: THREE.Vector3, sun: THREE.Vector3): RuinSite[] {
  const rnd = mulberry32(2187);
  const land: { d: THREE.Vector3; h: number; coast: boolean }[] = [];
  const peaks: { d: THREE.Vector3; h: number }[] = [];
  const d2 = new THREE.Vector3();
  const flat = (d: THREE.Vector3, h: number, dist: number, tol: number) => {
    const { east, north } = tangents(d);
    for (const [x, z] of [[dist, 0], [-dist, 0], [0, dist], [0, -dist]]) {
      offsetDir(d, east, north, R, x, z, d2);
      if (Math.abs(gen.height(d2.x, d2.y, d2.z, 300) - h) > tol) return false;
    }
    return true;
  };
  for (let i = 0; i < 2600; i++) {
    const z = rnd() * 2 - 1, ph = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
    const d = new THREE.Vector3(s * Math.cos(ph), z, s * Math.sin(ph));
    if (Math.abs(d.y) > 0.8) continue;
    const h = gen.height(d.x, d.y, d.z, 300);
    if (h > 12 && h < 280 && flat(d, h, 800, 45)) {
      const { east, north } = tangents(d);
      let coast = false;
      for (let k = 0; k < 8 && !coast; k++) {
        const a = (k / 8) * Math.PI * 2;
        offsetDir(d, east, north, R, Math.cos(a) * 3500, Math.sin(a) * 3500, d2);
        coast = gen.height(d2.x, d2.y, d2.z, 300) < 0;
      }
      land.push({ d, h, coast });
    } else if (h > 1600 && h < 4200 && flat(d, h, 250, 60)) peaks.push({ d, h });
  }
  const chosen: THREE.Vector3[] = [];
  const pick = <T extends { d: THREE.Vector3 }>(list: T[], from: THREE.Vector3, minAng: number, ok: (c: T) => boolean = () => true) => {
    let best: T | null = null, bd = -2;
    for (const c of list) {
      if (!ok(c) || chosen.some((q) => q.angleTo(c.d) < minAng)) continue;
      const dd = c.d.dot(from);
      if (dd > bd) { bd = dd; best = c; }
    }
    return best;
  };
  const out: RuinSite[] = [];
  let from = start.clone().normalize();
  for (const sd of SITE_DEFS) {
    const c = sd.kind === 'station'
      ? pick(peaks, from, 0.03) ?? pick(land, from, 0.03)
      : pick(land, from, out.length ? 0.055 : 0, sd.id === 'alba' ? (x) => x.coast : sd.id === 'telmo' ? (x) => x.d.dot(sun) < -0.25 : undefined) ?? pick(land, from, 0.055);
    if (!c) continue;
    chosen.push(c.d);
    from = c.d;
    const { east, north } = tangents(c.d);
    out.push({
      id: sd.id, name: sd.name, kind: sd.kind, dir: c.d.clone(), ground: gen.height(c.d.x, c.d.y, c.d.z, 0.7),
      radius: sd.radius, seed: 7000 + out.length * 131, logPos: new THREE.Vector3(), east, north,
    });
  }
  // the towns: spread over the land, at least ~250 km from any other ruin
  let ti = 0;
  for (const c of land) {
    if (ti >= TOWNS.length) break;
    if (chosen.some((q) => q.angleTo(c.d) < 0.04)) continue;
    chosen.push(c.d);
    const { east, north } = tangents(c.d);
    out.push({
      id: `town-${ti}`, name: TOWNS[ti], kind: 'city', dir: c.d.clone(), ground: gen.height(c.d.x, c.d.y, c.d.z, 0.7),
      radius: 260 + ((ti * 151) % 7) * 70, seed: 9000 + ti * 97, logPos: new THREE.Vector3(), east, north,
    });
    ti++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry: unit boxes standing on y = 0 (scaled per building), a broken top, rubble.
function brokenBox() {
  const g = new THREE.BoxGeometry(1, 1, 1, 3, 6, 3).translate(0, 0.5, 0);
  const n = new Noise3(51);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (y < 0.55) continue;
    const jag = 0.12 + 0.3 * Math.abs(n.noise(x * 2.7 + 3, 1.3, z * 2.7 - 1));
    p.setY(i, y - jag * ((y - 0.55) / 0.45));
  }
  g.computeVertexNormals();
  return g;
}
function rubbleGeo() {
  const g = new THREE.DodecahedronGeometry(1, 0);
  const n = new Noise3(77);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + n.noise(x * 1.9, y * 1.9, z * 1.9) * 0.35;
    p.setXYZ(i, x * k * 1.3, y * k * 0.55, z * k);
  }
  g.computeVertexNormals();
  return g;
}

/** empty windows on the facades (building-local metres from the instance scale) */
const WINDOWS_VERT = `
#ifdef USE_INSTANCING
vRuinP = position * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
#else
vRuinP = position;
#endif
vRuinN = normal;`;
const WINDOWS_FRAG = `
{
  vec3 an = abs(vRuinN);
  if (an.y < 0.5) {
    float along = an.x > an.z ? vRuinP.z : vRuinP.x;
    vec2 cell = vec2(along / 3.4, vRuinP.y / 3.3);
    vec2 f = fract(cell);
    float win = step(0.22, f.x) * step(f.x, 0.78) * step(0.3, f.y) * step(f.y, 0.82) * step(2.0, vRuinP.y);
    float h = fract(sin(dot(floor(cell), vec2(12.9898, 78.233))) * 43758.5453);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (0.05 + 0.12 * h), win);
  }
  // soot: burnt dark towards the street
  diffuseColor.rgb *= 0.7 + 0.3 * smoothstep(0.0, 8.0, vRuinP.y);
}
`;
function ruinMaterial(u: TerrainUniforms, windows: boolean) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: !windows });
  patchTerrainMaterial(m, u, windows ? 'ruin-windows-v1' : 'ruin-plain-v1');
  // Earth's ground gets the shadows of the clouds: so do its ruins (same uniforms)
  m.defines = { HELIOS_CLOUD_SHADOW: '' };
  if (windows) {
    const base = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      base.call(m, sh, r);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRuinP; varying vec3 vRuinN;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>' + WINDOWS_VERT);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRuinP; varying vec3 vRuinN;')
        .replace('float heliosDet = -1.0;', WINDOWS_FRAG + 'float heliosDet = -1.0;');
    };
  }
  return m;
}

// ---------------------------------------------------------------------------
export class RuinedEarth {
  sites: RuinSite[];
  private g: Game;
  private earth: Body;
  private cities = new Map<string, City>();
  private job: { site: RuinSite; it: Generator<void, City> } | null = null;
  private geo = { intact: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), broken: brokenBox(), rubble: rubbleGeo() };
  private mats: { windows: THREE.MeshStandardMaterial; plain: THREE.MeshStandardMaterial };
  /** terminals (the recordings): a steady amber screen, dimmed once read */
  private terminals = new Map<string, { root: THREE.Group; screen: THREE.MeshBasicMaterial }>();

  constructor(g: Game, earth: Body) {
    this.g = g;
    this.earth = earth;
    const R = earth.def.radius;
    // San Telmo lies on the night side: the story's first night (the Sun never moves in this sky)
    this.sites = findSites(earth.terrain!.gen, R, g.shipPos.clone().sub(earth.pos), earth.star.pos.clone().sub(earth.pos).normalize());
    for (const s of this.sites) {
      // the recording stands in the central square (cities) or beside the dome (station)
      const lx = s.kind === 'city' ? 0 : 14, lz = s.kind === 'city' ? 8 : -6;
      const d = offsetDir(s.dir, s.east, s.north, R, lx, lz);
      s.logPos.copy(d).multiplyScalar(R + g.terrainH(earth, d));
    }
    this.mats = { windows: ruinMaterial(earth.tUniforms!, true), plain: ruinMaterial(earth.tUniforms!, false) };
  }

  site(id: string) { return this.sites.find((s) => s.id === id); }
  /** the city's buildings exist (things can be placed around them) */
  built(id: string) { return this.cities.has(id); }
  /** the shelter of a story city (once built): on the ground relative to Earth's centre, and where its door faces */
  bunker(id: string) {
    const b = this.cities.get(id)?.bunker;
    return b ? { off: b.off.clone(), facing: b.facing.clone() } : null;
  }
  /** survival opened it: the door slides aside and the lamp goes dim */
  setBunkerOpen(id: string, open: boolean) {
    const b = this.cities.get(id)?.bunker;
    if (!b) return;
    b.door.position.x = open ? 1.15 : 0;
    if (open) b.lamp.color.setRGB(0.05, 0.035, 0.015);
  }

  /** world position of a site's centre on the ground */
  sitePos(s: RuinSite, out = new THREE.Vector3()) {
    return out.copy(s.dir).multiplyScalar(this.earth.def.radius + s.ground).add(this.earth.pos);
  }

  /** the nearest ruin to a point (for the HUD), within `max` metres */
  nearest(pos: THREE.Vector3, max: number) {
    let best: RuinSite | null = null, bd = max;
    const p = new THREE.Vector3();
    for (const s of this.sites) {
      const d = this.sitePos(s, p).distanceTo(pos);
      if (d < bd) { bd = d; best = s; }
    }
    return best ? { site: best, dist: bd } : null;
  }

  /** per frame: build cities as they come into range (a few ms a frame), place and drop them */
  update() {
    const g = this.g, cw = g.camWorld;
    const p = new THREE.Vector3();
    for (const s of this.sites) {
      const d = this.sitePos(s, p).distanceTo(cw);
      const city = this.cities.get(s.id);
      if (city) {
        if (d > DROP_DIST) { this.drop(city); continue; }
        city.group.visible = d < BUILD_DIST * 1.2;
        city.group.position.copy(p).sub(cw);
        if (city.group.visible) {
          // small rubble is invisible beyond a kilometre and a half: not drawn there
          const rel = this.sitePos(s, _r1).negate().add(cw);
          const cx = rel.dot(s.east), cz = rel.dot(s.north), cy = rel.dot(s.dir);
          for (const r of city.rubble) r.mesh.visible = Math.hypot(r.x - cx, r.z - cz, cy) < RUBBLE_DIST;
        }
      } else if (d < BUILD_DIST && !this.job) this.job = { site: s, it: this.generate(s) };
    }
    if (this.job) {
      const t0 = performance.now();
      while (performance.now() - t0 < 5) {
        const r = this.job.it.next();
        if (r.done) {
          const grp = r.value.group;
          grp.position.copy(this.sitePos(this.job.site, p)).sub(cw);
          this.cities.set(this.job.site.id, r.value);
          g.scene.add(grp);
          this.job = null;
          break;
        }
      }
    }
  }

  /** the recordings' terminals in the story's squares (both modes): amber screen, dimmed once heard; dim in exploration (readIds null) */
  updateTerminals(readIds: Set<string> | null, logSite: (id: string) => string | undefined) {
    const cw = this.g.camWorld, E = this.earth;
    const p = new THREE.Vector3();
    for (const s of this.sites) {
      const logId = logSite(s.id);
      let t = this.terminals.get(s.id);
      const rel = p.copy(s.logPos).add(E.pos).sub(cw);
      const near = rel.length() < 5000;
      if (!t && near && logId) t = this.makeTerminal(s);
      if (!t) continue;
      t.root.visible = near;
      t.root.position.copy(rel);
      if (!readIds) t.screen.color.setRGB(0.3, 0.18, 0.06);
      else if (logId && readIds.has(logId)) t.screen.color.setRGB(0.08, 0.05, 0.02);
      else t.screen.color.setRGB(0.9, 0.55, 0.18);
    }
  }

  private makeTerminal(s: RuinSite) {
    const root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.15, 0.4).translate(0, 0.575, 0), new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.7, metalness: 0.5 }));
    body.castShadow = true;
    const screen = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.55, 0.18) });
    const sm = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.28), screen);
    sm.position.set(0, 0.92, 0.205);
    root.add(body, sm);
    if (s.id === 'esperanza') {
      // the emergency beacon: a mast with a steady (never blinking) red lamp
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 12, 6).translate(0.9, 6, -0.4), new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.6, metalness: 0.6 }));
      mast.castShadow = true;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.85, 0.12, 0.08) }));
      lamp.position.set(0.9, 12.2, -0.4);
      root.add(mast, lamp);
    }
    const up = s.logPos.clone().normalize();
    // face the centre of the square
    root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(s.east, up, s.north)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    this.g.scene.add(root);
    const t = { root, screen };
    this.terminals.set(s.id, t);
    return t;
  }

  private drop(c: City) {
    this.g.scene.remove(c.group);
    for (const d of c.disposables) d.dispose();
    this.cities.delete(c.site.id);
  }

  /**
   * The buildings of the cities near a point: `fn` gets the site, the point's local coordinates and each
   * candidate building of the 3x3 cells around it (once each); returning true stops the search.
   * No allocation: it runs many times a frame (bolts, the camera, the watchers' sight).
   */
  private forNear(pos: THREE.Vector3, extra: number, fn: (s: RuinSite, lx: number, ly: number, lz: number, b: Building) => boolean | void) {
    for (const c of this.cities.values()) {
      const s = c.site;
      const rel = this.sitePos(s, _r2).negate().add(pos);
      if (rel.lengthSq() > (s.radius + 100 + extra) ** 2) continue;
      const lx = rel.dot(s.east), lz = rel.dot(s.north), ly = rel.dot(s.dir);
      const stamp = ++c.stamp;
      const gx = Math.floor(lx / CELL), gz = Math.floor(lz / CELL);
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const ids = c.grid.get(cellKey(gx + i, gz + j));
          if (!ids) continue;
          for (const k of ids) {
            if (c.seen[k] === stamp) continue;
            c.seen[k] = stamp;
            if (fn(s, lx, ly, lz, c.buildings[k])) return;
          }
        }
      }
    }
  }
  /** a point in a building's local frame: (u, v) across it, and how much room is left to each side */
  private local(b: Building, lx: number, lz: number, pad: number) {
    const dx = lx - b.x, dz = lz - b.z, cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
    const u = dx * cs - dz * sn, v = dx * sn + dz * cs;
    const L = _loc;
    L.u = u; L.v = v; L.pu = b.hx + pad - Math.abs(u); L.pv = b.hz + pad - Math.abs(v); L.cs = cs; L.sn = sn;
    return L;
  }

  /** a point inside a building (bolts hit walls, the camera stays out, watchers cannot see through) */
  solidAt(pos: THREE.Vector3) {
    let hit = false;
    this.forNear(pos, 0, (_s, lx, ly, lz, b) => {
      if (ly > b.base + b.h || ly < b.base) return;
      const l = this.local(b, lx, lz, 0);
      if (l.pu > 0 && l.pv > 0) return (hit = true);
    });
    return hit;
  }

  /** feet over a flat roof: how far under its top they are (negative: above it), or null */
  roof(pos: THREE.Vector3) {
    let best: number | null = null;
    this.forNear(pos, 0, (_s, lx, ly, lz, b) => {
      if (b.broken) return;
      const top = b.base + b.h;
      if (ly < top - 2 || ly > top + 1) return;
      const l = this.local(b, lx, lz, 0.15);
      if (l.pu > 0 && l.pv > 0 && (best === null || top - ly < best)) best = top - ly;
    });
    return best;
  }

  /** Keep the astronaut (or a creature: wider `pad`) out of the buildings: pushed back to the nearest wall. */
  collide(pos: THREE.Vector3, vel: THREE.Vector3, pad = 0.45) {
    this.forNear(pos, pad, (s, lx, ly, lz, b) => {
      // standing on (or just under) a flat roof: the walls do not push
      if (ly > b.base + b.h - (b.broken ? 0 : ROOF_BAND)) return;
      const l = this.local(b, lx, lz, pad);
      if (l.pu <= 0 || l.pv <= 0) return;
      let u = l.u, v = l.v;
      if (l.pu < l.pv) u = Math.sign(u || 1) * (b.hx + pad); else v = Math.sign(v || 1) * (b.hz + pad);
      const nx = b.x + u * l.cs + v * l.sn, nz = b.z - u * l.sn + v * l.cs;
      const push = _r3.set(0, 0, 0).addScaledVector(s.east, nx - lx).addScaledVector(s.north, nz - lz);
      pos.add(push);
      const n = push.normalize();
      const into = vel.dot(n);
      if (into < 0) vel.addScaledVector(n, -into);
    });
  }

  /**
   * The ship (a few metres wide): coming down on a building it rests on its top (a broken one's rubble
   * too); against a wall it is eased out sideways (a little each frame, never a jump).
   */
  shipCollide(pos: THREE.Vector3, vel: THREE.Vector3, clearance: number): 'roof' | 'wall' | null {
    let res: 'roof' | 'wall' | null = null;
    const PAD = 4;
    this.forNear(pos, PAD + 10, (s, lx, ly, lz, b) => {
      const vr = vel.dot(s.dir);
      const top = b.base + b.h;
      if (ly > top + clearance || ly < b.base - 3) return;
      const l = this.local(b, lx, lz, PAD);
      if (l.pu <= 0 || l.pv <= 0) return;
      // only from above: within the last few metres of the top, and not climbing
      if (ly > top + clearance - 3 && vr <= 1) {
        pos.addScaledVector(s.dir, top + clearance - ly);
        const v = vel.dot(s.dir);
        if (v < 0) vel.addScaledVector(s.dir, -v);
        res = 'roof';
        return;
      }
      let u = l.u, v = l.v;
      if (l.pu < l.pv) u = Math.sign(u || 1) * (b.hx + PAD); else v = Math.sign(v || 1) * (b.hz + PAD);
      const nx = b.x + u * l.cs + v * l.sn, nz = b.z - u * l.sn + v * l.cs;
      const push = _r3.set(0, 0, 0).addScaledVector(s.east, nx - lx).addScaledVector(s.north, nz - lz);
      if (push.length() > 1.5) push.setLength(1.5);
      pos.add(push);
      const n = push.normalize(), into = vel.dot(n);
      if (into < 0) vel.addScaledVector(n, -into);
      res = res ?? 'wall';
    });
    return res;
  }

  /** Builds one city a few buildings at a time (terrain heights under every corner are the slow part). */
  private *generate(s: RuinSite): Generator<void, City> {
    const g = this.g, E = this.earth, R = E.def.radius;
    const rnd = mulberry32(s.seed);
    const d = new THREE.Vector3();
    const ground = (x: number, z: number) => {
      offsetDir(s.dir, s.east, s.north, R, x, z, d);
      return g.terrainH(E, d) - s.ground - (x * x + z * z) / (2 * R);
    };
    const buildings: Building[] = [];
    const parts: { geo: 'intact' | 'broken'; m: THREE.Matrix4; c: THREE.Color }[] = [];
    const rubble: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
    const concrete = () => {
      const r = rnd();
      const c = r < 0.15 ? new THREE.Color(0.2, 0.12, 0.08) : r < 0.3 ? new THREE.Color(0.06, 0.055, 0.05) : new THREE.Color(0.16, 0.155, 0.145);
      return c.multiplyScalar(0.75 + rnd() * 0.5);
    };
    const addRubble = (x: number, z: number, size: number) => {
      const y = ground(x, z);
      e.set((rnd() - 0.5) * 0.6, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.6);
      rubble.push({ m: new THREE.Matrix4().compose(pos.set(x, y - size * 0.15, z), q.setFromEuler(e), sc.set(size, size, size)), c: concrete() });
    };
    const addBuilding = (x: number, z: number, hx: number, hz: number, yaw: number, h: number, broken: boolean, tilt: number) => {
      let base = Infinity;
      const cs = Math.cos(yaw), sn = Math.sin(yaw);
      for (const [u, v] of [[0, 0], [hx, hz], [-hx, hz], [hx, -hz], [-hx, -hz]]) base = Math.min(base, ground(x + u * cs + v * sn, z - u * sn + v * cs));
      base -= 1.5;
      buildings.push({ x, z, hx, hz, yaw, base, h: h + 1.5, broken });
      e.set((rnd() - 0.5) * tilt, yaw, (rnd() - 0.5) * tilt);
      parts.push({ geo: broken ? 'broken' : 'intact', m: new THREE.Matrix4().compose(pos.set(x, base, z), q.setFromEuler(e), sc.set(hx * 2, h + 1.5, hz * 2)), c: concrete() });
    };

    if (s.kind === 'city') {
      const block = 66, rot = rnd() * Math.PI, cr = Math.cos(rot), sr = Math.sin(rot);
      const n = Math.ceil(s.radius / block);
      let count = 0;
      for (let i = -n; i <= n; i++) {
        for (let j = -n; j <= n; j++) {
          const bx = i * block, bz = j * block;
          const dist = Math.hypot(bx, bz);
          if (dist > s.radius || dist < 45) continue; // the central square stays open
          const dens = 1 - Math.max(0, (dist - s.radius * 0.55) / (s.radius * 0.45));
          if (rnd() > 0.3 + 0.7 * dens) continue;
          const lots = rnd() < 0.45 ? 1 : 4;
          for (let k = 0; k < lots; k++) {
            const half = lots === 1 ? 0 : 1;
            const ox = half ? (k % 2 ? 1 : -1) * 13 : 0, oz = half ? (k < 2 ? 1 : -1) * 13 : 0;
            const size = lots === 1 ? 24 : 11;
            const hx = size * (0.6 + rnd() * 0.4), hz = size * (0.6 + rnd() * 0.4);
            const gx = bx + ox, gz = bz + oz;
            const x = gx * cr - gz * sr, z = gx * sr + gz * cr;
            const tall = 10 + 85 * Math.exp(-dist / (s.radius * 0.33)) * (0.35 + 0.65 * rnd());
            const r = rnd();
            if (r < 0.18) {
              // collapsed: only a heap of rubble is left
              for (let m = 0; m < 6; m++) addRubble(x + (rnd() - 0.5) * hx * 1.6, z + (rnd() - 0.5) * hz * 1.6, 1.5 + rnd() * 3.5);
            } else {
              const broken = r < 0.8;
              addBuilding(x, z, hx, hz, -rot, broken ? tall * (0.3 + rnd() * 0.6) : tall, broken, broken ? 0.09 : 0.02);
              for (let m = 0; m < (broken ? 4 : 1); m++) {
                const a = rnd() * Math.PI * 2, rr = Math.max(hx, hz) + 1 + rnd() * 5;
                addRubble(x + Math.cos(a) * rr, z + Math.sin(a) * rr, 0.6 + rnd() * 2);
              }
            }
            if (++count % 6 === 0) yield;
          }
        }
      }
      // debris in the streets and the square
      for (let m = 0; m < 90; m++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * s.radius;
        addRubble(Math.cos(a) * rr, Math.sin(a) * rr, 0.4 + rnd() * 1.2);
      }
    } else {
      // mountain observatory: a few low blocks around a dome, and the big dish
      const yaw = rnd() * Math.PI;
      for (const [x, z, hx, hz, h] of [[-22, 6, 9, 6, 7], [-20, -16, 6, 6, 5], [20, 18, 8, 5, 6], [26, -10, 5, 9, 9]]) addBuilding(x, z, hx, hz, yaw, h, rnd() < 0.5, 0.03);
      // (the observatory has no rubble field around its buildings: the mountain is bare)
      for (let m = 0; m < 20; m++) addRubble((rnd() - 0.5) * 70, (rnd() - 0.5) * 70, 0.4 + rnd() * 1.5);
    }
    yield;

    // meshes
    const group = new THREE.Group();
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(s.east, s.dir, s.north));
    const disposables: { dispose(): void }[] = [];
    const rubbleTiles: City['rubble'] = [];
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, list: { m: THREE.Matrix4; c: THREE.Color }[], small = false) => {
      // one instanced mesh per tile, each with its own bounds: the camera and the shadow skip whole tiles
      const tiles = new Map<string, { m: THREE.Matrix4; c: THREE.Color }[]>();
      const p = new THREE.Vector3();
      for (const it of list) {
        p.setFromMatrixPosition(it.m);
        const k = `${Math.floor(p.x / TILE)}:${Math.floor(p.z / TILE)}`;
        (tiles.get(k) ?? tiles.set(k, []).get(k)!).push(it);
      }
      for (const [k, items] of tiles) {
        const im = new THREE.InstancedMesh(geo, mat, items.length);
        items.forEach((it, i) => { im.setMatrixAt(i, it.m); im.setColorAt(i, it.c); });
        im.castShadow = true;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        group.add(im);
        disposables.push(im);
        if (small) { const [tx, tz] = k.split(':').map(Number); rubbleTiles.push({ mesh: im, x: (tx + 0.5) * TILE, z: (tz + 0.5) * TILE }); }
      }
    };
    inst(this.geo.intact, this.mats.windows, parts.filter((p) => p.geo === 'intact'));
    inst(this.geo.broken, this.mats.windows, parts.filter((p) => p.geo === 'broken'));
    inst(this.geo.rubble, this.mats.plain, rubble, true);
    if (s.kind === 'station') {
      const y0 = ground(0, 0) - 0.5;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(9, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), this.mats.plain);
      dome.position.set(0, y0, 0);
      // the dish: a broken shell on a pylon, tilted towards the sky
      const pylon = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 2, 19, 10).translate(0, 9.5, 0), this.mats.plain);
      pylon.position.set(-4, ground(-4, 28) - 0.5, 28);
      const dish = new THREE.Mesh(new THREE.SphereGeometry(14, 32, 12, 0, Math.PI * 1.7, 0, 0.75), new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide }));
      dish.position.set(-4, pylon.position.y + 30, 28);
      dish.rotation.set(Math.PI * 0.82, 0.4, 0.15);
      for (const m of [dome, pylon, dish]) { m.castShadow = true; m.receiveShadow = true; group.add(m); }
      disposables.push(dome.geometry, pylon.geometry, dish.geometry, dish.material);
    }
    // the story's shelter: a low concrete block with a door and a steady lamp, clear of the buildings
    let bunker: City['bunker'] = null;
    if (BUNKER_SITES.includes(s.id)) {
      let bx = s.kind === 'station' ? -30 : 58, bz = s.kind === 'station' ? 30 : -46;
      for (let it = 0; it < 4; it++) {
        for (const b of buildings) {
          const dx = bx - b.x, dz = bz - b.z, cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
          let u = dx * cs - dz * sn, v = dx * sn + dz * cs;
          const pu = b.hx + 3.5 - Math.abs(u), pv = b.hz + 3.5 - Math.abs(v);
          if (pu <= 0 || pv <= 0) continue;
          if (pu < pv) u = Math.sign(u || 1) * (b.hx + 3.5); else v = Math.sign(v || 1) * (b.hz + 3.5);
          bx = b.x + u * cs + v * sn; bz = b.z - u * sn + v * cs;
        }
      }
      const by = ground(bx, bz) - 0.05;
      const root = new THREE.Group();
      root.position.set(bx, by, bz);
      root.rotation.y = Math.PI; // the door faces south (-north)
      const body = new THREE.Mesh(BUNKER_GEO.body, BUNKER_MAT.concrete);
      const doorway = new THREE.Mesh(BUNKER_GEO.door, BUNKER_MAT.dark);
      doorway.position.set(0, 0.95, 1.805);
      const door = new THREE.Mesh(BUNKER_GEO.door, BUNKER_MAT.door);
      door.position.set(0, 0.95, 1.815);
      const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.85, 0.55, 0.18) });
      const lm = new THREE.Mesh(BUNKER_GEO.lamp, lamp);
      lm.position.set(0, 2.15, 1.86);
      root.add(body, doorway, door, lm);
      for (const m of [body, door]) { m.castShadow = true; m.receiveShadow = true; }
      group.add(root);
      disposables.push(lamp);
      buildings.push({ x: bx, z: bz, hx: 2, hz: 1.8, yaw: Math.PI, base: by, h: 2.6, broken: false });
      const d = offsetDir(s.dir, s.east, s.north, R, bx, bz);
      bunker = { off: d.clone().multiplyScalar(R + g.terrainH(E, d)), facing: s.north.clone().negate(), lamp, door };
    }
    const grid = new Map<number, number[]>();
    buildings.forEach((b, i) => {
      const r = Math.max(b.hx, b.hz) * 1.5;
      for (let cx = Math.floor((b.x - r) / CELL); cx <= Math.floor((b.x + r) / CELL); cx++) {
        for (let cz = Math.floor((b.z - r) / CELL); cz <= Math.floor((b.z + r) / CELL); cz++) {
          const k = cellKey(cx, cz);
          (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
        }
      }
    });
    return { site: s, group, buildings, grid, seen: new Uint32Array(buildings.length), stamp: 0, disposables, rubble: rubbleTiles, bunker };
  }

  dispose() {
    for (const c of [...this.cities.values()]) this.drop(c);
    for (const t of this.terminals.values()) this.g.scene.remove(t.root);
  }
}

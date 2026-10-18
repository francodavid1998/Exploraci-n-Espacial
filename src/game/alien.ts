import * as THREE from 'three';
import type { Game } from './Game';
import { mulberry32 } from './noise';
import { patchTerrainMaterial } from './shaders';

/**
 * The places of the signal (both game modes, like Earth's ruins): Base Tsiolkovsky on the
 * far side of the Moon with the buried artefact, three alien monoliths (the map fragments)
 * on the night sides of Mars, Europa and Proxima b, and the Spire on TRAPPIST-1 e, where
 * the signal comes from. All on ground the Sun never reaches. Built within a few dozen km.
 * Survival mode adds what can be done there (recordings, fragments, the Guardian).
 * Alien light is steady and dim: glyphs glow, nothing blinks.
 */
type Body = Game['bodies'][number];

export interface AlienSite {
  id: string;
  name: string;
  body: string;
  kind: 'base' | 'monolith' | 'spire';
  dir: THREE.Vector3;
  ground: number;
  east: THREE.Vector3;
  north: THREE.Vector3;
}

/** points of interest of each kind of site, in the site's local frame (x east, z north, metres) */
export const SITE_POINTS = {
  base: { t1: [-14, 5], t2: [17, -3], artefact: [0, 26] },
  monolith: { glyph: [0, 3.2] },
  spire: { guardian: [0, -42], pylons: [[60, 0], [-30, 52], [-30, -52]] },
} as const;

/** the far side of the Moon: 20° south of the point facing away from Earth (Tsiolkovsky crater) */
export function tsiolkovskyDir(g: Game) {
  const moon = g.byId.get('moon')!, earth = g.byId.get('earth')!;
  const away = moon.pos.clone().sub(earth.pos).normalize();
  return away.multiplyScalar(Math.cos(0.35)).add(new THREE.Vector3(0, -Math.sin(0.35), 0)).normalize();
}
/** deep night on a world: 50° from the point facing away from its star (but towards the dawn) */
export function nightDir(b: Body) {
  const night = b.star.pos.clone().sub(b.pos).normalize().negate();
  const side = new THREE.Vector3().crossVectors(night, new THREE.Vector3(0, 1, 0)).normalize();
  return night.multiplyScalar(Math.cos(0.87)).addScaledVector(side, Math.sin(0.87)).normalize();
}

function tangents(up: THREE.Vector3) {
  const ref = Math.abs(up.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const east = new THREE.Vector3().crossVectors(ref, up).normalize();
  return { east, north: new THREE.Vector3().crossVectors(east, up).normalize() };
}

interface Built { site: AlienSite; group: THREE.Group; colliders: { x: number; z: number; r: number; h: number }[] }

export class AlienWorld {
  sites: AlienSite[] = [];
  private g: Game;
  private built = new Map<string, Built>();
  /** glyph light (shared): survival dims it when the signal dies */
  glyph = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.42, 0.2, 0.75) });
  /** the shield pylons' cores of the Spire (survival darkens a destroyed one) */
  pylonCores: THREE.MeshBasicMaterial[] = [0, 1, 2].map(() => new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.25, 0.95) }));
  /** 1 = the signal is alive; fades to 0 when the Guardian falls */
  signal = 1;
  /** stone and metal share the light of the ground they stand on (its night look, haze...): one set per world */
  private mats = new Map<string, { obsidian: THREE.MeshStandardMaterial; hull: THREE.MeshStandardMaterial; dark: THREE.MeshStandardMaterial; panel: THREE.MeshStandardMaterial }>();
  /** the beacon's beam over the Spire: a faint steady column of light (fades with the signal) */
  private beam = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 0.22, 0.85), transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

  private matsFor(b: Body) {
    let m = this.mats.get(b.def.id);
    if (m) return m;
    const mk = (color: number, roughness: number, metalness: number, key: string) => {
      const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness });
      if (b.tUniforms) patchTerrainMaterial(mat, b.tUniforms, `alien-${key}`);
      return mat;
    };
    m = {
      obsidian: mk(0x2a2a38, 0.3, 0.12, 'obsidian'), hull: mk(0xbfc2c4, 0.55, 0.25, 'hull'),
      dark: mk(0x2a2d31, 0.6, 0.5, 'dark'), panel: mk(0x15243d, 0.3, 0.6, 'panel'),
    };
    this.mats.set(b.def.id, m);
    return m;
  }
  private lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.75, 0.68, 0.5) });

  constructor(g: Game) {
    this.g = g;
    const add = (id: string, name: string, body: string, kind: AlienSite['kind'], dir: THREE.Vector3) => {
      const b = g.byId.get(body);
      if (!b) return;
      const { east, north } = tangents(dir);
      // the terrain of other systems' worlds is read when they exist (they are built lazily)
      this.sites.push({ id, name, body, kind, dir, ground: NaN, east, north });
    };
    add('tsiolkovsky', 'Base Tsiolkovsky', 'moon', 'base', tsiolkovskyDir(g));
    add('frag-mars', 'Monolito de Marte', 'mars', 'monolith', nightDir(g.byId.get('mars')!));
    add('frag-europa', 'Monolito de Europa', 'europa', 'monolith', nightDir(g.byId.get('europa')!));
    add('frag-proxima', 'Monolito de Próxima b', 'proxima-b', 'monolith', nightDir(g.byId.get('proxima-b')!));
    add('spire', 'La Aguja', 'trappist-1e', 'spire', nightDir(g.byId.get('trappist-1e')!));
  }

  site(id: string) { return this.sites.find((s) => s.id === id); }
  body(s: AlienSite) { return this.g.byId.get(s.body)!; }

  private groundAt(s: AlienSite) {
    const b = this.body(s);
    if (Number.isNaN(s.ground) && b.terrain) s.ground = this.g.terrainH(b, s.dir);
    return Number.isNaN(s.ground) ? 0 : s.ground;
  }

  /** world position of a local point (x east, z north) on the ground of a site, `h` metres up */
  point(s: AlienSite, x: number, z: number, h = 0, out = new THREE.Vector3()) {
    const b = this.body(s), R = b.def.radius;
    const d = s.dir.clone().multiplyScalar(R).addScaledVector(s.east, x).addScaledVector(s.north, z).normalize();
    return out.copy(d).multiplyScalar(R + (b.terrain ? this.g.terrainH(b, d) : this.groundAt(s)) + h).add(b.pos);
  }
  centre(s: AlienSite, out = new THREE.Vector3()) {
    const b = this.body(s);
    return out.copy(s.dir).multiplyScalar(b.def.radius + this.groundAt(s)).add(b.pos);
  }

  update() {
    const g = this.g, cw = g.camWorld;
    const comfort = g.lightsMode === 'comfort' ? 0.7 : 1;
    this.glyph.color.setRGB(0.42 * comfort * this.signal, 0.2 * comfort * this.signal, 0.75 * comfort * this.signal);
    this.beam.opacity = 0.12 * comfort * this.signal;
    const p = new THREE.Vector3();
    for (const s of this.sites) {
      const b = this.body(s);
      const here = b.star === g.sunBody && !!b.terrain;
      const d = here ? this.centre(s, p).distanceTo(cw) : Infinity;
      let bt = this.built.get(s.id);
      if (!bt && d < 40e3) {
        bt = this.build(s);
        this.built.set(s.id, bt);
        g.scene.add(bt.group);
      } else if (bt && d > 80e3) {
        g.scene.remove(bt.group);
        this.built.delete(s.id);
        continue;
      }
      if (bt) bt.group.position.copy(this.centre(s, p)).sub(cw);
    }
  }

  /** keep the astronaut out of the structures */
  collide(pos: THREE.Vector3, vel: THREE.Vector3) {
    const p = new THREE.Vector3();
    for (const bt of this.built.values()) {
      const s = bt.site;
      const rel = pos.clone().sub(this.centre(s, p));
      if (rel.lengthSq() > 250 * 250) continue;
      const lx = rel.dot(s.east), lz = rel.dot(s.north), ly = rel.dot(s.dir);
      for (const c of bt.colliders) {
        const dx = lx - c.x, dz = lz - c.z, dd = Math.hypot(dx, dz), r = c.r + 0.4;
        if (dd >= r || ly > c.h) continue;
        const k = (r - dd) / Math.max(dd, 1e-3);
        const push = new THREE.Vector3().addScaledVector(s.east, dx * k).addScaledVector(s.north, dz * k);
        pos.add(push);
        const n = push.normalize(), into = vel.dot(n);
        if (into < 0) vel.addScaledVector(n, -into);
      }
    }
  }

  private build(s: AlienSite): Built {
    const group = new THREE.Group();
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(s.east, s.dir, s.north));
    const colliders: Built['colliders'] = [];
    const b = this.body(s), R = b.def.radius;
    const { obsidian, hull, dark, panel } = this.matsFor(b);
    // local ground height (relative to the site centre) so things stand on the terrain
    const y0 = (x: number, z: number) => {
      const d = s.dir.clone().multiplyScalar(R).addScaledVector(s.east, x).addScaledVector(s.north, z).normalize();
      return this.g.terrainH(b, d) - this.groundAt(s) - (x * x + z * z) / (2 * R);
    };
    const put = (m: THREE.Object3D, x: number, z: number, h = 0, sink = 0.3) => {
      m.position.set(x, y0(x, z) - sink + h, z);
      m.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      group.add(m);
      return m;
    };
    const glyphs = (w: number, h: number, n: number, seed: number, thick = 0.07) => {
      // thin glowing lines engraved on a face (local, facing +z)
      const g = new THREE.Group(), rnd = mulberry32(seed);
      for (let i = 0; i < n; i++) {
        const vert = rnd() < 0.5;
        const len = (vert ? h : w) * (0.15 + rnd() * 0.35);
        const line = new THREE.Mesh(new THREE.PlaneGeometry(vert ? thick : len, vert ? len : thick), this.glyph);
        line.position.set((rnd() - 0.5) * w * 0.8, (0.1 + rnd() * 0.8) * h, 0);
        g.add(line);
      }
      return g;
    };
    const monolith = (x: number, z: number, w: number, h: number, d: number, seed: number, tilt = 0) => {
      const m = new THREE.Group();
      const slab = new THREE.Mesh(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), obsidian);
      m.add(slab);
      // glyphs on both broad faces
      const gl = glyphs(w, h, 14, seed);
      gl.position.z = d / 2 + 0.01;
      const gb = glyphs(w, h, 14, seed + 1000);
      gb.position.z = -d / 2 - 0.01;
      gb.rotation.y = Math.PI;
      m.add(gl, gb);
      m.rotation.set(tilt, (seed % 7) * 0.4, tilt * 0.5);
      put(m, x, z, 0, 0.8);
      colliders.push({ x, z, r: Math.max(w, d) * 0.6, h: h });
      return m;
    };

    if (s.kind === 'base') {
      // habitat modules lying on the regolith, a dome, an antenna and solar panels
      for (const [x, z, rot] of [[-22, 2, 0], [-22, 16, 0], [21, -8, 0.4]]) {
        const mod = new THREE.Group();
        const cyl = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 11, 16), hull);
        cyl.rotation.z = Math.PI / 2;
        cyl.position.y = 2.4;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.12, 6, 20), dark);
        ring.rotation.y = Math.PI / 2;
        ring.position.set(3, 2.4, 0);
        const win = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.5), this.lamp);
        win.position.set(-2, 2.9, 2.42);
        mod.add(cyl, ring, win);
        mod.rotation.y = rot;
        put(mod, x, z);
        colliders.push({ x: x - 3, z, r: 2.6, h: 5 }, { x: x + 3, z, r: 2.6, h: 5 });
      }
      const dome = new THREE.Mesh(new THREE.SphereGeometry(6, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), hull);
      put(dome, 2, -24);
      colliders.push({ x: 2, z: -24, r: 6, h: 6 });
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.3, 22, 6).translate(0, 11, 0), dark);
      put(mast, 14, 20);
      const dish = new THREE.Mesh(new THREE.SphereGeometry(3, 20, 8, 0, Math.PI * 2, 0, 0.8), new THREE.MeshStandardMaterial({ color: 0xd0d0cc, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide }));
      dish.rotation.x = Math.PI;
      put(dish, 14, 20, 22.5, 0);
      for (let i = 0; i < 4; i++) {
        const pnl = new THREE.Mesh(new THREE.BoxGeometry(6, 0.1, 3), panel);
        pnl.rotation.x = -0.5;
        put(pnl, -38 + i * 7, -14, 1.6, 0);
      }
      // the excavation: work lights around a black artefact half out of the ground
      const [ax, az] = SITE_POINTS.base.artefact;
      const art = monolith(ax, az + 4, 2.2, 9, 1.6, 31, 0.18);
      art.position.y -= 2;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const lp = new THREE.Group();
        lp.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3.2, 5).translate(0, 1.6, 0), dark));
        const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 0.25), this.lamp);
        bulb.position.y = 3.2;
        lp.add(bulb);
        put(lp, ax + Math.cos(a) * 9, az + 4 + Math.sin(a) * 9);
      }
      // the recordings' terminals (screens dim: power failing)
      for (const [x, z] of [SITE_POINTS.base.t1, SITE_POINTS.base.t2]) {
        const t = new THREE.Group();
        t.add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.15, 0.4).translate(0, 0.575, 0), dark));
        const sc = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.28), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 0.38, 0.12) }));
        sc.position.set(0, 0.92, 0.205);
        t.add(sc);
        t.rotation.y = Math.atan2(-x, -z); // facing the centre of the base
        put(t, x, z, 0, 0.05);
      }
    } else if (s.kind === 'monolith') {
      // a black slab twice the height of a house in a ring of standing stones
      monolith(0, 0, 3.4, 13, 1.3, 7);
      const rnd = mulberry32(s.id.length * 97);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + rnd() * 0.2;
        monolith(Math.cos(a) * 16, Math.sin(a) * 16, 1 + rnd() * 0.8, 2.5 + rnd() * 3, 0.8, 11 + i, (rnd() - 0.5) * 0.3);
      }
    } else {
      // the Spire: a tapering twisted tower of black stone, ~170 m, glyphs spiralling up
      const SEG_H = 15;
      for (let i = 0; i < 12; i++) {
        const w = 26 * (1 - i / 13) + 2, h = SEG_H;
        const seg = new THREE.Group();
        const block = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.55, w * 0.62, h, 6).translate(0, h / 2, 0), obsidian);
        seg.add(block);
        // glyphs on every other face of the hexagon, just outside it (apothem of the mid radius)
        const ap = w * 0.62 * Math.cos(Math.PI / 6) + 0.08, face = w * 0.585;
        for (let f = 0; f < 6; f += 2) {
          const gl = glyphs(face * 0.8, h, 5, 50 + i * 7 + f, 0.45);
          const a = (f + 0.5) * (Math.PI / 3);
          gl.position.set(Math.sin(a) * ap, 0, Math.cos(a) * ap);
          gl.rotation.y = a;
          seg.add(gl);
        }
        seg.rotation.y = i * 0.35;
        put(seg, 0, 0, i * h * 0.95, 1);
      }
      // the beacon: a violet core on top and its beam into the sky
      const coreM = new THREE.Mesh(new THREE.OctahedronGeometry(2.2, 0), this.glyph);
      put(coreM, 0, 0, 12 * SEG_H * 0.95 + 3, 0);
      const beamM = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 3000, 12, 1, true).translate(0, 1500, 0), this.beam);
      beamM.castShadow = false;
      put(beamM, 0, 0, 12 * SEG_H * 0.95 + 3, 0);
      beamM.castShadow = false;
      beamM.receiveShadow = false;
      beamM.renderOrder = 5;
      colliders.push({ x: 0, z: 0, r: 17, h: 180 });
      // three shield pylons around it
      SITE_POINTS.spire.pylons.forEach(([x, z], i) => {
        const py = new THREE.Group();
        py.add(new THREE.Mesh(new THREE.CylinderGeometry(1.2, 2.4, 14, 5).translate(0, 7, 0), obsidian));
        const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.6, 0), this.pylonCores[i]);
        core.position.y = 16.5;
        py.add(core);
        put(py, x, z);
        colliders.push({ x, z, r: 2.6, h: 18 });
      });
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        monolith(Math.cos(a) * 95, Math.sin(a) * 95, 1.5, 4 + (i % 3) * 2, 1, 70 + i);
      }
    }
    return { site: s, group, colliders };
  }

  dispose() {
    for (const bt of this.built.values()) this.g.scene.remove(bt.group);
    this.built.clear();
  }
}

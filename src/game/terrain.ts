import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TerrainGen } from './bodies';
import { mulberry32, Noise3 } from './noise';

const SEG = 32;
const VN = SEG + 1;
const GN = SEG + 3;
const SPLIT_K = 1.55;

const FACES = [
  { n: [1, 0, 0], a: [0, 0, -1], b: [0, 1, 0] },
  { n: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0] },
  { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, -1] },
  { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
  { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
  { n: [0, 0, -1], a: [-1, 0, 0], b: [0, 1, 0] },
];

function spherify(x: number, y: number, z: number, out: number[]) {
  const x2 = x * x, y2 = y * y, z2 = z * z;
  const sx = x * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3));
  const sy = y * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3));
  const sz = z * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3));
  const l = Math.hypot(sx, sy, sz);
  out[0] = sx / l; out[1] = sy / l; out[2] = sz / l;
}

// Shared index buffers
let GRID_INDEX: THREE.BufferAttribute | null = null;
let WATER_INDEX: THREE.BufferAttribute | null = null;
function gridIndex() {
  if (GRID_INDEX) return GRID_INDEX;
  const idx: number[] = [];
  const id = (i: number, j: number) => j * VN + i;
  for (let j = 0; j < SEG; j++)
    for (let i = 0; i < SEG; i++) {
      const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
      idx.push(a, b, c, a, c, d);
    }
  const water = idx.slice();
  const base = VN * VN;
  const edges: [(k: number) => number, number][] = [
    [(k) => id(k, 0), base],
    [(k) => id(k, SEG), base + VN],
    [(k) => id(0, k), base + 2 * VN],
    [(k) => id(SEG, k), base + 3 * VN],
  ];
  for (const [fn, sb] of edges) {
    for (let k = 0; k < SEG; k++) {
      const a = fn(k), b = fn(k + 1), sa = sb + k, sbb = sb + k + 1;
      idx.push(a, b, sa, b, sbb, sa);
      idx.push(a, sa, b, b, sa, sbb);
    }
  }
  GRID_INDEX = new THREE.BufferAttribute(new Uint16Array(idx), 1);
  WATER_INDEX = new THREE.BufferAttribute(new Uint16Array(water), 1);
  return GRID_INDEX;
}

// Shared instanced geometries
let ROCK_GEO: THREE.BufferGeometry | null = null;
let CONIFER_GEO: THREE.BufferGeometry | null = null;
let BROAD_GEO: THREE.BufferGeometry | null = null;
function rockGeo() {
  if (ROCK_GEO) return ROCK_GEO;
  const g = new THREE.IcosahedronGeometry(1, 2);
  const n = new Noise3(4242);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const d = 1 + n.noise(v.x * 1.3, v.y * 1.3, v.z * 1.3) * 0.35 + n.noise(v.x * 4, v.y * 4, v.z * 4) * 0.1;
    v.multiplyScalar(d);
    v.y *= 0.62;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  ROCK_GEO = g;
  return g;
}
function colorize(g: THREE.BufferGeometry, c: [number, number, number]) {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
function coniferGeo() {
  if (CONIFER_GEO) return CONIFER_GEO;
  const parts = [
    colorize(new THREE.CylinderGeometry(0.12, 0.22, 2.2, 6).translate(0, 1.1, 0).toNonIndexed(), [0.18, 0.11, 0.06]),
    colorize(new THREE.ConeGeometry(1.7, 3.6, 8).translate(0, 3.2, 0).toNonIndexed(), [0.05, 0.13, 0.05]),
    colorize(new THREE.ConeGeometry(1.35, 3.0, 8).translate(0, 4.8, 0).toNonIndexed(), [0.055, 0.14, 0.055]),
    colorize(new THREE.ConeGeometry(0.9, 2.5, 8).translate(0, 6.3, 0).toNonIndexed(), [0.06, 0.15, 0.06]),
  ];
  CONIFER_GEO = mergeGeometries(parts)!;
  CONIFER_GEO.computeVertexNormals();
  return CONIFER_GEO;
}
function broadGeo() {
  if (BROAD_GEO) return BROAD_GEO;
  const n = new Noise3(77);
  const crown = new THREE.IcosahedronGeometry(2.4, 1);
  const p = crown.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + n.noise(v.x, v.y, v.z) * 0.22);
    v.y *= 0.8;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  crown.translate(0, 4.6, 0);
  const parts = [
    colorize(new THREE.CylinderGeometry(0.16, 0.28, 3.2, 6).translate(0, 1.6, 0).toNonIndexed(), [0.2, 0.13, 0.07]),
    colorize(crown.toNonIndexed(), [0.1, 0.2, 0.06]),
  ];
  BROAD_GEO = mergeGeometries(parts)!;
  BROAD_GEO.computeVertexNormals();
  return BROAD_GEO;
}

export class TerrainNode {
  children: TerrainNode[] | null = null;
  mesh: THREE.Mesh | null = null;
  water: THREE.Mesh | null = null;
  extras: THREE.Object3D[] = [];
  built = false;
  center = new THREE.Vector3();
  worldSize: number;
  constructor(
    public face: number, public level: number,
    public u0: number, public v0: number, public size: number, R: number,
  ) {
    this.worldSize = R * size * 0.8;
    const f = FACES[face];
    const u = u0 + size / 2, v = v0 + size / 2;
    const d = [0, 0, 0];
    spherify(f.n[0] + f.a[0] * u + f.b[0] * v, f.n[1] + f.a[1] * u + f.b[1] * v, f.n[2] + f.a[2] * u + f.b[2] * v, d);
    this.center.set(d[0] * R, d[1] * R, d[2] * R);
  }
}

export class PlanetTerrain {
  group = new THREE.Group();
  roots: TerrainNode[] = [];
  maxLevel: number;
  private queue: { node: TerrainNode; d: number }[] = [];
  private tmpH = new Float64Array(GN * GN);
  private tmpP = new Float64Array(GN * GN * 3);
  private tmpD = new Float64Array(GN * GN * 3);
  chunkCount = 0;

  constructor(
    public R: number,
    public gen: TerrainGen,
    public material: THREE.Material,
    public waterMaterial: THREE.Material | null,
    public rockMaterial: THREE.Material,
    public treeMaterial: THREE.Material,
  ) {
    gridIndex();
    this.maxLevel = Math.max(2, Math.ceil(Math.log2((R * 1.6) / 22)));
    for (let f = 0; f < 6; f++) {
      const n = new TerrainNode(f, 0, -1, -1, 2, R);
      this.build(n);
      this.roots.push(n);
    }
  }

  heightAt(dx: number, dy: number, dz: number) {
    return this.gen.height(dx, dy, dz, 0.7);
  }

  private build(node: TerrainNode) {
    const R = this.R;
    const gen = this.gen;
    const f = FACES[node.face];
    const step = node.size / SEG;
    const spacing = node.worldSize / SEG;
    const minWl = Math.max(spacing * 1.3, 0.7);
    const H = this.tmpH, P = this.tmpP, D = this.tmpD;
    const d = [0, 0, 0];
    let minH = Infinity, maxH = -Infinity;
    for (let j = 0; j < GN; j++) {
      for (let i = 0; i < GN; i++) {
        const u = node.u0 + (i - 1) * step;
        const v = node.v0 + (j - 1) * step;
        spherify(f.n[0] + f.a[0] * u + f.b[0] * v, f.n[1] + f.a[1] * u + f.b[1] * v, f.n[2] + f.a[2] * u + f.b[2] * v, d);
        const h = gen.height(d[0], d[1], d[2], minWl);
        const k = j * GN + i;
        H[k] = h;
        D[k * 3] = d[0]; D[k * 3 + 1] = d[1]; D[k * 3 + 2] = d[2];
        const r = R + h;
        P[k * 3] = d[0] * r; P[k * 3 + 1] = d[1] * r; P[k * 3 + 2] = d[2] * r;
        if (i > 0 && j > 0 && i < GN - 1 && j < GN - 1) {
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
        }
      }
    }
    const ck = ((SEG >> 1) + 1) * GN + (SEG >> 1) + 1;
    const cx = P[ck * 3], cy = P[ck * 3 + 1], cz = P[ck * 3 + 2];
    node.center.set(cx, cy, cz);

    const nv = VN * VN + 4 * VN;
    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 3);
    const skirt = node.worldSize * 0.025 + 1;
    for (let j = 0; j < VN; j++) {
      for (let i = 0; i < VN; i++) {
        const k = (j + 1) * GN + (i + 1);
        const o = j * VN + i;
        pos[o * 3] = P[k * 3] - cx; pos[o * 3 + 1] = P[k * 3 + 1] - cy; pos[o * 3 + 2] = P[k * 3 + 2] - cz;
        const kl = k - 1, kr = k + 1, kd = k - GN, ku = k + GN;
        const ax = P[kr * 3] - P[kl * 3], ay = P[kr * 3 + 1] - P[kl * 3 + 1], az = P[kr * 3 + 2] - P[kl * 3 + 2];
        const bx = P[ku * 3] - P[kd * 3], by = P[ku * 3 + 1] - P[kd * 3 + 1], bz = P[ku * 3 + 2] - P[kd * 3 + 2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        const ux = D[k * 3], uy = D[k * 3 + 1], uz = D[k * 3 + 2];
        if (nx * ux + ny * uy + nz * uz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        nor[o * 3] = nx; nor[o * 3 + 1] = ny; nor[o * 3 + 2] = nz;
        const slope = 1 - (nx * ux + ny * uy + nz * uz);
        gen.color(ux, uy, uz, H[k], slope, col, o);
      }
    }
    // skirts
    const edgeIdx = (e: number, k: number) => (e === 0 ? k : e === 1 ? SEG * VN + k : e === 2 ? k * VN : k * VN + SEG);
    for (let e = 0; e < 4; e++) {
      for (let k = 0; k < VN; k++) {
        const src = edgeIdx(e, k);
        const dst = VN * VN + e * VN + k;
        const gi = e === 0 ? GN + 1 + k : e === 1 ? (SEG + 1) * GN + 1 + k : e === 2 ? (k + 1) * GN + 1 : (k + 1) * GN + SEG + 1;
        pos[dst * 3] = pos[src * 3] - D[gi * 3] * skirt;
        pos[dst * 3 + 1] = pos[src * 3 + 1] - D[gi * 3 + 1] * skirt;
        pos[dst * 3 + 2] = pos[src * 3 + 2] - D[gi * 3 + 2] * skirt;
        for (let c = 0; c < 3; c++) { nor[dst * 3 + c] = nor[src * 3 + c]; col[dst * 3 + c] = col[src * 3 + c]; }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(GRID_INDEX!);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(cx, cy, cz);
    mesh.receiveShadow = true;
    mesh.castShadow = node.worldSize < 20000;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    this.group.add(mesh);
    node.mesh = mesh;

    // water
    const sea = gen.seaLevel;
    if (sea !== null && this.waterMaterial && minH < sea + 2) {
      const wpos = new Float32Array(VN * VN * 3);
      const wnor = new Float32Array(VN * VN * 3);
      const wdep = new Float32Array(VN * VN);
      for (let j = 0; j < VN; j++)
        for (let i = 0; i < VN; i++) {
          const k = (j + 1) * GN + (i + 1);
          const o = j * VN + i;
          const r = R + sea;
          wpos[o * 3] = D[k * 3] * r - cx; wpos[o * 3 + 1] = D[k * 3 + 1] * r - cy; wpos[o * 3 + 2] = D[k * 3 + 2] * r - cz;
          wnor[o * 3] = D[k * 3]; wnor[o * 3 + 1] = D[k * 3 + 1]; wnor[o * 3 + 2] = D[k * 3 + 2];
          wdep[o] = sea - H[k];
        }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
      wg.setAttribute('normal', new THREE.BufferAttribute(wnor, 3));
      wg.setAttribute('depth', new THREE.BufferAttribute(wdep, 1));
      wg.setIndex(WATER_INDEX!);
      wg.computeBoundingSphere();
      const wm = new THREE.Mesh(wg, this.waterMaterial);
      wm.position.copy(mesh.position);
      wm.matrixAutoUpdate = false;
      wm.updateMatrix();
      wm.visible = false;
      wm.renderOrder = 2;
      this.group.add(wm);
      node.water = wm;
    }

    // scattered rocks & trees on fine chunks
    if (node.worldSize < 260) this.scatterRocks(node, pos, nor, col, H, sea);
    if (gen.trees && node.worldSize < 700) this.scatterTrees(node, pos, nor, D, H);

    node.built = true;
    this.chunkCount++;
  }

  private sample(pos: Float32Array, nor: Float32Array, fu: number, fv: number, outP: THREE.Vector3, outN: THREE.Vector3) {
    const i = Math.min(SEG - 1, Math.floor(fu)), j = Math.min(SEG - 1, Math.floor(fv));
    const tu = fu - i, tv = fv - j;
    const a = j * VN + i, b = a + 1, c = a + VN, d = c + 1;
    const w = [(1 - tu) * (1 - tv), tu * (1 - tv), (1 - tu) * tv, tu * tv];
    const ids = [a, b, c, d];
    outP.set(0, 0, 0); outN.set(0, 0, 0);
    for (let q = 0; q < 4; q++) {
      const k = ids[q];
      outP.x += pos[k * 3] * w[q]; outP.y += pos[k * 3 + 1] * w[q]; outP.z += pos[k * 3 + 2] * w[q];
      outN.x += nor[k * 3] * w[q]; outN.y += nor[k * 3 + 1] * w[q]; outN.z += nor[k * 3 + 2] * w[q];
    }
    outN.normalize();
    return a;
  }

  private scatterRocks(node: TerrainNode, pos: Float32Array, nor: Float32Array, col: Float32Array, H: Float64Array, sea: number | null) {
    const area = node.worldSize * node.worldSize;
    const midH = H[((SEG >> 1) + 1) * GN + (SEG >> 1) + 1];
    const dens = this.gen.rocks(midH, 0.1);
    const count = Math.min(900, Math.floor(area * dens));
    if (count < 1) return;
    const rnd = mulberry32((node.face * 73856093) ^ Math.floor(node.u0 * 1e7) ^ Math.floor(node.v0 * 3e7) ^ node.level);
    const im = new THREE.InstancedMesh(rockGeo(), this.rockMaterial, count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const p = new THREE.Vector3(), n = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const qr = new THREE.Quaternion(), c = new THREE.Color();
    let placed = 0;
    for (let k = 0; k < count; k++) {
      const fu = rnd() * SEG, fv = rnd() * SEG;
      const a = this.sample(pos, nor, fu, fv, p, n);
      const hk = H[(Math.floor(fv) + 1) * GN + Math.floor(fu) + 1];
      if (sea !== null && hk < sea + 0.5) continue;
      const slopeK = 1 - Math.max(0, n.dot(p.clone().add(node.center).normalize()));
      if (rnd() > this.gen.rocks(hk, slopeK) / Math.max(dens, 1e-6)) continue;
      const r = rnd();
      const sc = (0.12 + Math.pow(r, 6) * 2.6 + Math.pow(rnd(), 30) * 4) * this.gen.rockScale;
      q.setFromUnitVectors(up, n);
      qr.setFromAxisAngle(up, rnd() * Math.PI * 2);
      q.multiply(qr);
      s.set(sc * (0.8 + rnd() * 0.5), sc * (0.7 + rnd() * 0.6), sc * (0.8 + rnd() * 0.5));
      p.addScaledVector(n, -sc * 0.25);
      m.compose(p, q, s);
      im.setMatrixAt(placed, m);
      const b = 0.75 + rnd() * 0.35;
      c.setRGB(col[a * 3] * b * 1.15, col[a * 3 + 1] * b * 1.1, col[a * 3 + 2] * b * 1.05);
      im.setColorAt(placed, c);
      placed++;
    }
    im.count = placed;
    if (placed === 0) return;
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    node.mesh!.add(im);
    node.extras.push(im);
  }

  private scatterTrees(node: TerrainNode, pos: Float32Array, nor: Float32Array, D: Float64Array, H: Float64Array) {
    const gen = this.gen;
    if (!gen.trees) return;
    const area = node.worldSize * node.worldSize;
    const maxCount = Math.min(1400, Math.floor(area * 0.006));
    if (maxCount < 1) return;
    const rnd = mulberry32((node.face * 19349663) ^ Math.floor(node.u0 * 7e6) ^ Math.floor(node.v0 * 9e6) ^ (node.level * 7));
    const kc = ((SEG >> 1) + 1) * GN + (SEG >> 1) + 1;
    const cy = D[kc * 3 + 1];
    const conifer = Math.abs(cy) > 0.62 || H[kc] > 1800;
    const im = new THREE.InstancedMesh(conifer ? coniferGeo() : broadGeo(), this.treeMaterial, maxCount);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const p = new THREE.Vector3(), n = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
    const qr = new THREE.Quaternion(), c = new THREE.Color();
    let placed = 0;
    for (let k = 0; k < maxCount; k++) {
      const fu = rnd() * SEG, fv = rnd() * SEG;
      this.sample(pos, nor, fu, fv, p, n);
      dir.copy(p).add(node.center).normalize();
      const h = H[(Math.floor(fv) + 1) * GN + Math.floor(fu) + 1];
      const slope = 1 - n.dot(dir);
      const dens = gen.trees(dir.x, dir.y, dir.z, h, slope);
      if (rnd() > dens / 0.006) continue;
      const sc = 0.7 + rnd() * 0.9;
      q.setFromUnitVectors(up, dir);
      qr.setFromAxisAngle(up, rnd() * Math.PI * 2);
      q.multiply(qr);
      s.set(sc, sc * (0.85 + rnd() * 0.4), sc);
      p.addScaledVector(dir, -0.3);
      m.compose(p, q, s);
      im.setMatrixAt(placed, m);
      const b = 0.75 + rnd() * 0.45;
      c.setRGB(b, b * (0.95 + rnd() * 0.1), b);
      im.setColorAt(placed, c);
      placed++;
    }
    im.count = placed;
    if (placed === 0) { im.dispose(); return; }
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    node.mesh!.add(im);
    node.extras.push(im);
  }

  private setVisible(node: TerrainNode, v: boolean) {
    if (node.mesh) node.mesh.visible = v;
    if (node.water) node.water.visible = v;
  }

  private hideTree(node: TerrainNode) {
    this.setVisible(node, false);
    if (node.children) for (const c of node.children) this.hideTree(c);
  }

  private dispose(node: TerrainNode) {
    if (node.children) for (const c of node.children) this.dispose(c);
    node.children = null;
    if (node.mesh) {
      this.group.remove(node.mesh);
      node.mesh.geometry.dispose();
      for (const e of node.extras) (e as THREE.InstancedMesh).dispose?.();
      node.mesh = null;
      node.extras = [];
    }
    if (node.water) {
      this.group.remove(node.water);
      node.water.geometry.dispose();
      node.water = null;
    }
    if (node.built) this.chunkCount--;
    node.built = false;
  }

  private updateNode(node: TerrainNode, cam: THREE.Vector3) {
    const dist = cam.distanceTo(node.center);
    const want = node.level < this.maxLevel && dist < node.worldSize * SPLIT_K;
    if (want) {
      if (!node.children) {
        const hs = node.size / 2;
        node.children = [
          new TerrainNode(node.face, node.level + 1, node.u0, node.v0, hs, this.R),
          new TerrainNode(node.face, node.level + 1, node.u0 + hs, node.v0, hs, this.R),
          new TerrainNode(node.face, node.level + 1, node.u0, node.v0 + hs, hs, this.R),
          new TerrainNode(node.face, node.level + 1, node.u0 + hs, node.v0 + hs, hs, this.R),
        ];
      }
      let ready = true;
      for (const c of node.children) {
        if (!c.built) {
          ready = false;
          this.queue.push({ node: c, d: cam.distanceTo(c.center) / c.worldSize });
        }
      }
      if (ready) {
        this.setVisible(node, false);
        for (const c of node.children) this.updateNode(c, cam);
      } else {
        this.setVisible(node, true);
        for (const c of node.children) this.hideTree(c);
      }
    } else {
      this.setVisible(node, true);
      if (node.children) {
        if (dist > node.worldSize * SPLIT_K * 1.3) {
          for (const c of node.children) this.dispose(c);
          node.children = null;
        } else {
          for (const c of node.children) this.hideTree(c);
        }
      }
    }
  }

  /** cam: camera position in body-local coordinates */
  update(cam: THREE.Vector3, budgetMs: number) {
    this.queue.length = 0;
    for (const r of this.roots) this.updateNode(r, cam);
    if (!this.queue.length) return 0;
    this.queue.sort((a, b) => a.d - b.d);
    const t0 = performance.now();
    let n = 0;
    for (const q of this.queue) {
      if (q.node.built) continue;
      this.build(q.node);
      n++;
      if (performance.now() - t0 > budgetMs) break;
    }
    return this.queue.length - n;
  }

  /** show only root level (for far planets) */
  collapse() {
    for (const r of this.roots) {
      this.setVisible(r, true);
      if (r.children) {
        for (const c of r.children) this.dispose(c);
        r.children = null;
      }
    }
  }
}

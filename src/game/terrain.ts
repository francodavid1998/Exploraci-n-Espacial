import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TerrainGen } from './bodies';
import { Noise3 } from './noise';
import { buildChunkData, chunkWorldSize, FACES, SEG, VN, spherify, type ChunkData, type ChunkRequest } from './terrainBuild';
import TerrainWorker from './terrainWorker?worker&inline';

const SPLIT_K = 1.55;

// ---------------------------------------------------------------------------
// Worker pool. Building one chunk costs several milliseconds of pure JS (a
// 35x35 grid of multi-octave noise plus rock/tree scattering); done on the main
// thread it stalled the frame every time the player moved near a planet. The
// pool builds chunks in parallel off-thread; the main thread only turns the
// returned arrays into meshes. Falls back to synchronous builds without workers.
// ---------------------------------------------------------------------------
class ChunkWorkerPool {
  private workers: Worker[] = [];
  private next = 0;
  private seq = 0;
  private pending = new Map<number, (d: ChunkData) => void>();
  inFlight = 0;
  get size() { return this.workers.length; }
  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const w = new TerrainWorker();
      w.onmessage = (e: MessageEvent<{ id: number; data?: ChunkData; error?: string }>) => {
        this.inFlight--;
        const cb = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        if (e.data.error) console.warn('[terrain worker]', e.data.error);
        else if (cb && e.data.data) cb(e.data.data);
      };
      this.workers.push(w);
    }
  }
  request(req: ChunkRequest, cb: (d: ChunkData) => void): number {
    const id = ++this.seq;
    this.pending.set(id, cb);
    this.inFlight++;
    this.workers[this.next++ % this.workers.length].postMessage({ id, ...req });
    return id;
  }
  /** The result, if it still arrives, is dropped. */
  cancel(id: number) { this.pending.delete(id); }
}

let pool: ChunkWorkerPool | null | undefined;
function getPool(): ChunkWorkerPool | null {
  if (pool === undefined) {
    try {
      const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
      pool = new ChunkWorkerPool(n);
    } catch (err) {
      console.warn('[terrain] workers unavailable, building chunks on the main thread', err);
      pool = null;
    }
  }
  return pool;
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
  /** worker request id while a build is in flight */
  pending = 0;
  center = new THREE.Vector3();
  worldSize: number;
  constructor(
    public face: number, public level: number,
    public u0: number, public v0: number, public size: number, R: number,
  ) {
    this.worldSize = chunkWorldSize(R, size);
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
  chunkCount = 0;

  constructor(
    public bodyId: string,
    public R: number,
    public gen: TerrainGen,
    public material: THREE.Material,
    public waterMaterial: THREE.Material | null,
    public rockMaterial: THREE.Material,
    public treeMaterial: THREE.Material,
    /** build the six root chunks on the worker threads (a world created while travelling) */
    asyncRoots = false,
  ) {
    gridIndex();
    this.maxLevel = Math.max(2, Math.ceil(Math.log2((R * 1.6) / 22)));
    // the six root chunks: right away for the starting system, off-thread otherwise
    for (let f = 0; f < 6; f++) {
      const n = new TerrainNode(f, 0, -1, -1, 2, R);
      this.roots.push(n);
      if (!asyncRoots) this.applyChunk(n, buildChunkData(this.gen, this.R, this.request(n)));
    }
    if (asyncRoots) this.requestRoots();
  }

  private requestRoots() {
    const p = getPool();
    for (const n of this.roots) {
      if (n.built || n.pending) continue;
      if (!p) { this.applyChunk(n, buildChunkData(this.gen, this.R, this.request(n))); continue; }
      n.pending = p.request(this.request(n), (data) => {
        n.pending = 0;
        if (!n.built) this.applyChunk(n, data);
      });
    }
  }

  heightAt(dx: number, dy: number, dz: number) {
    return this.gen.height(dx, dy, dz, 0.7);
  }

  private request(node: TerrainNode): ChunkRequest {
    return { bodyId: this.bodyId, face: node.face, level: node.level, u0: node.u0, v0: node.v0, size: node.size, hasWater: !!this.waterMaterial };
  }

  /** Turn built chunk data into meshes (cheap: typed arrays become GPU buffers). */
  private applyChunk(node: TerrainNode, data: ChunkData) {
    const [cx, cy, cz] = data.center;
    node.center.set(cx, cy, cz);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.col, 3));
    geo.setIndex(GRID_INDEX!);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(cx, cy, cz);
    mesh.receiveShadow = true;
    // The terrain receives shadows but never casts them: the shadow map only covers a
    // 90 m slab around the player, so at low sun the ground inside the slab was black
    // with its own ripples' shadows while the ground outside had none, a hard wedge
    // pointing away from the Sun. Slopes still shade by their own tilt; the player,
    // the ship, rocks and trees keep casting their long sunset shadows.
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // a root chunk shows as soon as it exists (a far world that is never updated must
    // still be seen); updateNode sets everything else
    mesh.visible = node.level === 0;
    this.group.add(mesh);
    node.mesh = mesh;

    if (data.water && this.waterMaterial) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(data.water.pos, 3));
      wg.setAttribute('normal', new THREE.BufferAttribute(data.water.nor, 3));
      wg.setAttribute('depth', new THREE.BufferAttribute(data.water.depth, 1));
      wg.setIndex(WATER_INDEX!);
      wg.computeBoundingSphere();
      const wm = new THREE.Mesh(wg, this.waterMaterial);
      wm.position.copy(mesh.position);
      wm.matrixAutoUpdate = false;
      wm.updateMatrix();
      wm.visible = node.level === 0;
      wm.renderOrder = 2;
      this.group.add(wm);
      node.water = wm;
    }

    if (data.rocks) this.addInstances(node, rockGeo(), this.rockMaterial, data.rocks.count, data.rocks.matrices, data.rocks.colors);
    if (data.trees) this.addInstances(node, data.trees.conifer ? coniferGeo() : broadGeo(), this.treeMaterial, data.trees.count, data.trees.matrices, data.trees.colors);

    node.built = true;
    this.chunkCount++;
  }

  private addInstances(node: TerrainNode, geo: THREE.BufferGeometry, mat: THREE.Material, count: number, matrices: Float32Array, colors: Float32Array) {
    const im = new THREE.InstancedMesh(geo, mat, count);
    (im.instanceMatrix.array as Float32Array).set(matrices.subarray(0, count * 16));
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor = new THREE.InstancedBufferAttribute(colors.subarray(0, count * 3).slice(), 3);
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
    if (node.pending) { getPool()?.cancel(node.pending); node.pending = 0; }
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

  /**
   * cam: camera position in body-local coordinates. Returns the number of
   * chunks still to be built. With workers, `budgetMs` only bounds the
   * synchronous fallback; builds are dispatched off-thread, nearest first.
   */
  update(cam: THREE.Vector3, budgetMs: number) {
    this.queue.length = 0;
    for (const r of this.roots) this.updateNode(r, cam);
    if (!this.queue.length) return 0;
    this.queue.sort((a, b) => a.d - b.d);
    const p = getPool();
    if (p) {
      for (const q of this.queue) {
        const node = q.node;
        if (node.built || node.pending) continue;
        if (p.inFlight >= p.size * 2) break;
        node.pending = p.request(this.request(node), (data) => {
          node.pending = 0;
          if (node.built) return; // disposed and rebuilt meanwhile: results for the old request are dropped by cancel()
          this.applyChunk(node, data);
        });
      }
      return this.queue.filter((q) => !q.node.built).length;
    }
    const t0 = performance.now();
    let n = 0;
    for (const q of this.queue) {
      if (q.node.built) continue;
      this.applyChunk(q.node, buildChunkData(this.gen, this.R, this.request(q.node)));
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

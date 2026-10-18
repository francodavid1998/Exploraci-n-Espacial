// Pure chunk-building math, shared by the terrain worker and the main-thread
// fallback. Deliberately free of three.js so the worker bundle stays tiny and
// results travel as plain transferable typed arrays.
import type { TerrainGen } from './bodies';
import { mulberry32 } from './noise';

export const SEG = 32;
export const VN = SEG + 1;
export const GN = SEG + 3;

export const FACES = [
  { n: [1, 0, 0], a: [0, 0, -1], b: [0, 1, 0] },
  { n: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0] },
  { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, -1] },
  { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
  { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
  { n: [0, 0, -1], a: [-1, 0, 0], b: [0, 1, 0] },
];

export function spherify(x: number, y: number, z: number, out: number[]) {
  const x2 = x * x, y2 = y * y, z2 = z * z;
  const sx = x * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3));
  const sy = y * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3));
  const sz = z * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3));
  const l = Math.hypot(sx, sy, sz);
  out[0] = sx / l; out[1] = sy / l; out[2] = sz / l;
}

export function chunkWorldSize(R: number, size: number) {
  return R * size * 0.8;
}

export interface ChunkRequest {
  bodyId: string;
  face: number;
  level: number;
  u0: number;
  v0: number;
  size: number;
  hasWater: boolean;
}

export interface InstanceData {
  count: number;
  matrices: Float32Array; // 16 floats per instance, column-major
  colors: Float32Array; // 3 floats per instance (linear RGB)
}

export interface ChunkData {
  center: [number, number, number];
  pos: Float32Array;
  nor: Float32Array;
  col: Float32Array;
  water: { pos: Float32Array; nor: Float32Array; depth: Float32Array } | null;
  rocks: InstanceData | null;
  /** kind: 0 conifer, 1 broadleaf, 2 dead */
  trees: (InstanceData & { kind: number }) | null;
}

/** Buffers to hand over with postMessage (zero-copy). */
export function chunkTransferables(d: ChunkData): Transferable[] {
  const arrays: ArrayBufferView[] = [d.pos, d.nor, d.col];
  if (d.water) arrays.push(d.water.pos, d.water.nor, d.water.depth);
  if (d.rocks) arrays.push(d.rocks.matrices, d.rocks.colors);
  if (d.trees) arrays.push(d.trees.matrices, d.trees.colors);
  return arrays.map((a) => a.buffer as ArrayBuffer);
}

// --- tiny quaternion / matrix helpers (same formulas as three.js) ---------------
type Quat = [number, number, number, number];

function quatFromUnitVectors(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): Quat {
  let r = fx * tx + fy * ty + fz * tz + 1;
  let x: number, y: number, z: number;
  if (r < Number.EPSILON) {
    r = 0;
    if (Math.abs(fx) > Math.abs(fz)) { x = -fy; y = fx; z = 0; } else { x = 0; y = -fz; z = fy; }
  } else {
    x = fy * tz - fz * ty; y = fz * tx - fx * tz; z = fx * ty - fy * tx;
  }
  const l = Math.hypot(x, y, z, r) || 1;
  return [x / l, y / l, z / l, r / l];
}

function quatFromAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const h = angle / 2, s = Math.sin(h);
  return [ax * s, ay * s, az * s, Math.cos(h)];
}

function quatMul(a: Quat, b: Quat): Quat {
  const [qax, qay, qaz, qaw] = a, [qbx, qby, qbz, qbw] = b;
  return [
    qax * qbw + qaw * qbx + qay * qbz - qaz * qby,
    qay * qbw + qaw * qby + qaz * qbx - qax * qbz,
    qaz * qbw + qaw * qbz + qax * qby - qay * qbx,
    qaw * qbw - qax * qbx - qay * qby - qaz * qbz,
  ];
}

function compose(out: Float32Array, o: number, px: number, py: number, pz: number, q: Quat, sx: number, sy: number, sz: number) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[o] = (1 - (yy + zz)) * sx; out[o + 1] = (xy + wz) * sx; out[o + 2] = (xz - wy) * sx; out[o + 3] = 0;
  out[o + 4] = (xy - wz) * sy; out[o + 5] = (1 - (xx + zz)) * sy; out[o + 6] = (yz + wx) * sy; out[o + 7] = 0;
  out[o + 8] = (xz + wy) * sz; out[o + 9] = (yz - wx) * sz; out[o + 10] = (1 - (xx + yy)) * sz; out[o + 11] = 0;
  out[o + 12] = px; out[o + 13] = py; out[o + 14] = pz; out[o + 15] = 1;
}

/** Bilinear sample of the chunk grid (position and normal) at fractional grid coordinates. */
function sample(pos: Float32Array, nor: Float32Array, fu: number, fv: number, outP: number[], outN: number[]) {
  const i = Math.min(SEG - 1, Math.floor(fu)), j = Math.min(SEG - 1, Math.floor(fv));
  const tu = fu - i, tv = fv - j;
  const a = j * VN + i, b = a + 1, c = a + VN, d = c + 1;
  const w = [(1 - tu) * (1 - tv), tu * (1 - tv), (1 - tu) * tv, tu * tv];
  const ids = [a, b, c, d];
  outP[0] = outP[1] = outP[2] = 0; outN[0] = outN[1] = outN[2] = 0;
  for (let q = 0; q < 4; q++) {
    const k = ids[q];
    outP[0] += pos[k * 3] * w[q]; outP[1] += pos[k * 3 + 1] * w[q]; outP[2] += pos[k * 3 + 2] * w[q];
    outN[0] += nor[k * 3] * w[q]; outN[1] += nor[k * 3 + 1] * w[q]; outN[2] += nor[k * 3 + 2] * w[q];
  }
  const l = Math.hypot(outN[0], outN[1], outN[2]) || 1;
  outN[0] /= l; outN[1] /= l; outN[2] /= l;
  return a;
}

// scratch buffers (one builder runs at a time per thread)
const H = new Float64Array(GN * GN);
const P = new Float64Array(GN * GN * 3);
const D = new Float64Array(GN * GN * 3);

/** Everything a chunk needs: terrain grid, skirts, water sheet and scattered rocks/trees. */
export function buildChunkData(gen: TerrainGen, R: number, req: Omit<ChunkRequest, 'bodyId'>): ChunkData {
  const { face, level, u0, v0, size, hasWater } = req;
  const worldSize = chunkWorldSize(R, size);
  const f = FACES[face];
  const step = size / SEG;
  const spacing = worldSize / SEG;
  const minWl = Math.max(spacing * 1.3, 0.7);
  const d = [0, 0, 0];
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < GN; j++) {
    for (let i = 0; i < GN; i++) {
      const u = u0 + (i - 1) * step;
      const v = v0 + (j - 1) * step;
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

  const nv = VN * VN + 4 * VN;
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const col = new Float32Array(nv * 3);
  const skirt = worldSize * 0.025 + 1;
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

  // water
  const sea = gen.seaLevel;
  let water: ChunkData['water'] = null;
  if (sea !== null && hasWater && minH < sea + 2) {
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
    water = { pos: wpos, nor: wnor, depth: wdep };
  }

  const rocks = worldSize < 260 ? scatterRocks(gen, face, level, u0, v0, worldSize, cx, cy, cz, pos, nor, col, sea) : null;
  const trees = gen.trees && worldSize < 700 ? scatterTrees(gen, face, level, u0, v0, worldSize, cx, cy, cz, pos, nor) : null;
  void maxH;
  return { center: [cx, cy, cz], pos, nor, col, water, rocks, trees };
}

function scatterRocks(gen: TerrainGen, face: number, level: number, u0: number, v0: number, worldSize: number, cx: number, cy: number, cz: number,
  pos: Float32Array, nor: Float32Array, col: Float32Array, sea: number | null): InstanceData | null {
  const area = worldSize * worldSize;
  const midH = H[((SEG >> 1) + 1) * GN + (SEG >> 1) + 1];
  const dens = gen.rocks(midH, 0.1);
  const count = Math.min(900, Math.floor(area * dens));
  if (count < 1) return null;
  const rnd = mulberry32((face * 73856093) ^ Math.floor(u0 * 1e7) ^ Math.floor(v0 * 3e7) ^ level);
  const matrices = new Float32Array(count * 16);
  const colors = new Float32Array(count * 3);
  const p = [0, 0, 0], n = [0, 0, 0];
  let placed = 0;
  for (let k = 0; k < count; k++) {
    const fu = rnd() * SEG, fv = rnd() * SEG;
    const a = sample(pos, nor, fu, fv, p, n);
    const hk = H[(Math.floor(fv) + 1) * GN + Math.floor(fu) + 1];
    if (sea !== null && hk < sea + 0.5) continue;
    // slope relative to the local vertical
    let rx = p[0] + cx, ry = p[1] + cy, rz = p[2] + cz;
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const slopeK = 1 - Math.max(0, n[0] * rx + n[1] * ry + n[2] * rz);
    if (rnd() > gen.rocks(hk, slopeK) / Math.max(dens, 1e-6)) continue;
    const r = rnd();
    const sc = (0.12 + Math.pow(r, 6) * 2.6 + Math.pow(rnd(), 30) * 4) * gen.rockScale;
    let q = quatFromUnitVectors(0, 1, 0, n[0], n[1], n[2]);
    q = quatMul(q, quatFromAxisAngle(0, 1, 0, rnd() * Math.PI * 2));
    const sx = sc * (0.8 + rnd() * 0.5), sy = sc * (0.7 + rnd() * 0.6), sz = sc * (0.8 + rnd() * 0.5);
    compose(matrices, placed * 16, p[0] - n[0] * sc * 0.25, p[1] - n[1] * sc * 0.25, p[2] - n[2] * sc * 0.25, q, sx, sy, sz);
    const b = 0.75 + rnd() * 0.35;
    colors[placed * 3] = col[a * 3] * b * 1.15; colors[placed * 3 + 1] = col[a * 3 + 1] * b * 1.1; colors[placed * 3 + 2] = col[a * 3 + 2] * b * 1.05;
    placed++;
  }
  if (placed === 0) return null;
  return { count: placed, matrices, colors };
}

function scatterTrees(gen: TerrainGen, face: number, level: number, u0: number, v0: number, worldSize: number, cx: number, cy: number, cz: number,
  pos: Float32Array, nor: Float32Array): (InstanceData & { kind: number }) | null {
  if (!gen.trees) return null;
  const area = worldSize * worldSize;
  const maxCount = Math.min(1400, Math.floor(area * 0.006));
  if (maxCount < 1) return null;
  const rnd = mulberry32((face * 19349663) ^ Math.floor(u0 * 7e6) ^ Math.floor(v0 * 9e6) ^ (level * 7));
  const kc = ((SEG >> 1) + 1) * GN + (SEG >> 1) + 1;
  const cyD = D[kc * 3 + 1];
  const kind = gen.treeKind ? gen.treeKind(D[kc * 3], cyD, D[kc * 3 + 2], H[kc]) : Math.abs(cyD) > 0.62 || H[kc] > 1800 ? 0 : 1;
  const matrices = new Float32Array(maxCount * 16);
  const colors = new Float32Array(maxCount * 3);
  const p = [0, 0, 0], n = [0, 0, 0];
  let placed = 0;
  for (let k = 0; k < maxCount; k++) {
    const fu = rnd() * SEG, fv = rnd() * SEG;
    sample(pos, nor, fu, fv, p, n);
    let dx = p[0] + cx, dy = p[1] + cy, dz = p[2] + cz;
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    const h = H[(Math.floor(fv) + 1) * GN + Math.floor(fu) + 1];
    const slope = 1 - (n[0] * dx + n[1] * dy + n[2] * dz);
    const dens = gen.trees(dx, dy, dz, h, slope);
    if (rnd() > dens / 0.006) continue;
    const sc = 0.7 + rnd() * 0.9;
    let q = quatFromUnitVectors(0, 1, 0, dx, dy, dz);
    q = quatMul(q, quatFromAxisAngle(0, 1, 0, rnd() * Math.PI * 2));
    const sy = sc * (0.85 + rnd() * 0.4);
    compose(matrices, placed * 16, p[0] - dx * 0.3, p[1] - dy * 0.3, p[2] - dz * 0.3, q, sc, sy, sc);
    const b = 0.75 + rnd() * 0.45;
    const tn = gen.treeTint ? gen.treeTint(dx, dy, dz) : null;
    colors[placed * 3] = b * (tn ? tn[0] : 1); colors[placed * 3 + 1] = b * (0.95 + rnd() * 0.1) * (tn ? tn[1] : 1); colors[placed * 3 + 2] = b * (tn ? tn[2] : 1);
    placed++;
  }
  if (placed === 0) return null;
  return { kind, count: placed, matrices, colors };
}

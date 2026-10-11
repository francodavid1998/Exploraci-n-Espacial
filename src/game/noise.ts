// Procedural noise utilities (CPU, double precision)

const GRAD3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);
const F3 = 1 / 3;
const G3 = 1 / 6;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export class Noise3 {
  perm = new Uint8Array(512);
  permMod12 = new Uint8Array(512);
  constructor(seed: number) {
    const rnd = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const r = Math.floor(rnd() * (i + 1));
      const t = p[i];
      p[i] = p[r];
      p[r] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise(xin: number, yin: number, zin: number): number {
    const perm = this.perm;
    const pm = this.permMod12;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = pm[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = pm[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = pm[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = pm[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }
    return 32 * n;
  }

  /** fBm with LOD cut-off: octaves with wavelength < minWl are skipped (faded) */
  fbm(x: number, y: number, z: number, baseWl: number, octaves: number, minWl: number, gain = 0.5, lac = 2.0): number {
    let sum = 0, amp = 1, wl = baseWl;
    for (let o = 0; o < octaves; o++) {
      if (wl < minWl) break;
      const f = Math.min(1, wl / minWl - 1);
      const inv = 1 / wl;
      sum += this.noise(x * inv + o * 13.17, y * inv - o * 7.31, z * inv + o * 3.73) * amp * f;
      amp *= gain;
      wl /= lac;
    }
    return sum;
  }

  /** ridged multifractal in [0, ~1.5] */
  ridged(x: number, y: number, z: number, baseWl: number, octaves: number, minWl: number, gain = 0.5, lac = 2.0): number {
    let sum = 0, amp = 0.6, wl = baseWl, weight = 1;
    for (let o = 0; o < octaves; o++) {
      if (wl < minWl) break;
      const f = Math.min(1, wl / minWl - 1);
      const inv = 1 / wl;
      let r = 1 - Math.abs(this.noise(x * inv + o * 5.1, y * inv + o * 9.7, z * inv - o * 2.3));
      r *= r;
      r *= weight;
      weight = Math.min(1, Math.max(0, r * 2));
      sum += r * amp * f;
      amp *= gain;
      wl /= lac;
    }
    return sum;
  }
}

export function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
export function clamp(x: number, a: number, b: number) {
  return x < a ? a : x > b ? b : x;
}
export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function smin(a: number, b: number, k: number) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}
function smax(a: number, b: number, k: number) {
  return -smin(-a, -b, k);
}

export function craterShape(d: number, central: boolean): number {
  const cavity = d * d - 1;
  const rimX = Math.min(d - 1.7, 0);
  const rim = 0.42 * rimX * rimX;
  let s = smax(cavity, -0.55, 0.25);
  s = smin(s, rim, 0.25);
  if (central) s += 0.35 * Math.exp(-(d * d) / 0.02);
  return s;
}

// Random rotations per crater octave to hide the grid
const ROTS: number[][] = [];
{
  const r = mulberry32(9137);
  for (let i = 0; i < 24; i++) {
    // random quaternion -> matrix
    const u1 = r(), u2 = r(), u3 = r();
    const qx = Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2);
    const qy = Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2);
    const qz = Math.sqrt(u1) * Math.sin(2 * Math.PI * u3);
    const qw = Math.sqrt(u1) * Math.cos(2 * Math.PI * u3);
    ROTS.push([
      1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
      2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
      2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
    ]);
  }
}

/**
 * Multi-scale crater field. x,y,z in meters (body local). Returns height offset in meters.
 */
export function craterField(
  x: number, y: number, z: number, seed: number,
  maxCell: number, minCell: number, density: number, depthMul: number, minWl: number,
): number {
  let h = 0;
  let cell = maxCell;
  let o = 0;
  while (cell >= minCell) {
    const rMaxM = cell * 0.22;
    if (rMaxM * 1.2 < minWl) break;
    const fade = Math.min(1, (rMaxM * 1.2) / minWl - 1);
    const m = ROTS[(o + seed) % ROTS.length];
    const inv = 1 / cell;
    const px = (m[0] * x + m[1] * y + m[2] * z) * inv + 0.37 * o;
    const py = (m[3] * x + m[4] * y + m[5] * z) * inv + 0.71 * o;
    const pz = (m[6] * x + m[7] * y + m[8] * z) * inv + 0.13 * o;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    const s = seed * 31 + o * 977;
    if (hash3(ix, iy, iz, s) < density) {
      const r = 0.08 + 0.14 * hash3(ix, iy, iz, s + 1);
      const mm = 1.7 * r;
      const span = 1 - 2 * mm;
      const cx = ix + mm + span * hash3(ix, iy, iz, s + 2);
      const cy = iy + mm + span * hash3(ix, iy, iz, s + 3);
      const cz = iz + mm + span * hash3(ix, iy, iz, s + 4);
      const dx = px - cx, dy = py - cy, dz = pz - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / r;
      if (d < 1.7) {
        const rM = r * cell;
        const depth = rM < 5000 ? 0.4 * rM : 2000 * Math.pow(rM / 5000, 0.35);
        h += craterShape(d, rM > 9000) * depth * depthMul * fade;
      }
    }
    cell *= 0.5;
    o++;
  }
  return h;
}

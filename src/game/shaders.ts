import * as THREE from 'three';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { StarDef } from './bodies';
import { mulberry32 } from './noise';
import { STAR_COUNT, STAR_DATA } from './starCatalog';

export const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
float fbm(vec3 p, int oct){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 10; i++){
    if (i >= oct) break;
    s += a * snoise(p);
    p = p * 2.03 + vec3(1.7, -3.1, 2.3);
    a *= 0.5;
  }
  return s;
}
vec2 rsi(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r*r;
  float d = b*b - c;
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
`;


const SHELL_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
varying vec3 vObj;
varying vec3 vNormalW;
void main(){
  vObj = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

// ---------------------------------------------------------------------------
/** optical-depth table size (sun angle x altitude) */
const LUT_W = 128, LUT_H = 64;
/**
 * Sunlight reaching a point at radius lr (planet radii) with the Sun at cos(zenith) =
 * musun: transmittance through the air above it, 0 once the planet hides the Sun. The
 * table only covers rays above the local horizon (with more resolution near it), so the
 * twilight glow lasts until the Sun really sets there. Needs uRa, uBetaR, uBetaM, uBetaO, uLut.
 */
const SUN_TRANSMITTANCE_GLSL = /* glsl */ `
vec3 sunTransmittance(float lr, float musun){
  float muHor = -sqrt(max(1.0 - 1.0 / (lr * lr), 0.0));
  vec2 xy = vec2(sqrt(clamp((musun - muHor) / (1.0 - muHor), 0.0, 1.0)), clamp((lr - 1.0) / (uRa - 1.0), 0.0, 1.0));
  vec2 uv = (xy * vec2(${LUT_W - 1}.0, ${LUT_H - 1}.0) + 0.5) / vec2(${LUT_W}.0, ${LUT_H}.0); // texel centres
  vec2 odl = textureLod(uLut, uv, 0.0).rg;
  vec3 tau = (uBetaR + uBetaO) * odl.x + uBetaM * 1.1 * odl.y;
  // the Sun sinks behind the planet over its own apparent diameter (0.53 deg)
  return exp(-tau) * smoothstep(muHor - 0.0047, muHor + 0.0047, musun);
}
`;

export function makeAtmosphereMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: new THREE.Vector3() },
      uRa: { value: 1.02 },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uBetaR: { value: new THREE.Vector3() },
      uBetaM: { value: 0 },
      uHR: { value: 0.001 },
      uHM: { value: 0.001 },
      uG: { value: 0.76 },
      uSun: { value: 20 },
      uMieTint: { value: new THREE.Vector3(1, 1, 1) },
      uFade: { value: 1 },
      /** ozone absorption (planet radii⁻¹, Rayleigh density profile): no scattering, it only takes red and green out of long twilight paths, which makes the "blue hour" */
      uBetaO: { value: new THREE.Vector3() },
      // optical depth towards the Sun, precomputed per body (see makeOpticalDepthLut)
      uLut: { value: null as THREE.Texture | null },
    },
    // View-ray sample count; raised by the graphics quality level (Game.applyQuality).
    defines: { ATMO_NS: 12 },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCenter; uniform float uRa; uniform vec3 uSunDir; uniform vec3 uBetaR; uniform float uBetaM;
uniform float uHR; uniform float uHM; uniform float uG; uniform float uSun; uniform vec3 uMieTint; uniform float uFade;
uniform vec3 uBetaO; uniform sampler2D uLut;
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
${NOISE_GLSL}
${SUN_TRANSMITTANCE_GLSL}
void main(){
  #include <logdepthbuf_fragment>
  vec3 rd = normalize(vWorld);
  vec3 ro = -uCenter;
  vec2 a = rsi(ro, rd, uRa);
  if (a.x > a.y || a.y < 0.0) { gl_FragColor = vec4(0.0); return; }
  vec2 p = rsi(ro, rd, 1.0);
  float t0 = max(a.x, 0.0);
  float t1 = a.y;
  if (p.x < p.y && p.x > 0.0) t1 = min(t1, p.x);
  const int NS = ATMO_NS;
  float ds = (t1 - t0) / float(NS);
  vec3 L = vec3(0.0), Tv = vec3(1.0);
  float mu = dot(rd, uSunDir);
  float phR = 3.0 / (16.0 * PI) * (1.0 + mu*mu);
  float g = uG;
  float phM = 3.0 / (8.0 * PI) * ((1.0 - g*g) * (1.0 + mu*mu)) / ((2.0 + g*g) * pow(max(1.0 + g*g - 2.0*g*mu, 1e-4), 1.5));
  // Energy-conserving integration: each segment's in-scattering is integrated exactly for
  // its density, so long horizon paths (coarse steps) keep the right colour.
  for (int i = 0; i < NS; i++){
    vec3 pos = ro + rd * (t0 + ds * (float(i) + 0.5));
    float lr = length(pos);
    float h = max(lr - 1.0, 0.0);
    float rR = exp(-h / uHR), rM = exp(-h / uHM);
    vec3 ext = (uBetaR + uBetaO) * rR + uBetaM * 1.1 * rM;
    // sunlight reaching this point: one table lookup instead of a second ray march
    vec3 S = (uBetaR * (rR * phR) + uBetaM * (rM * phM) * uMieTint) * sunTransmittance(lr, dot(pos / lr, uSunDir));
    vec3 segT = exp(-ext * ds);
    L += S * Tv * mix((1.0 - segT) / max(ext, vec3(1e-20)), vec3(ds), step(ext * ds, vec3(1e-4)));
    Tv *= segT;
  }
  vec3 col = uSun * L;
  gl_FragColor = vec4(col * uFade, 0.0); // alpha 0: the atmosphere shell is part of the planet for the bloom mask
}
`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.ZeroFactor, // additive colour; alpha := 0 wherever the shell draws (bloom mask)
    side: THREE.FrontSide,
  });
}

/**
 * Optical depth table for an atmosphere: for a point at normalized altitude h
 * (0 = ground, 1 = top) and a Sun above its horizon, the Rayleigh and Mie optical
 * depths along the ray to the top of the atmosphere. Columns run from the local
 * horizon (x = 0) to the zenith (x = 1) with x² spacing, so grazing sunset rays get
 * most of the resolution; the shader handles the Sun below the horizon itself.
 * (A first version stored hidden rays as an "opaque" 1e4 over the full angle range:
 * filtering blended that into the last lit column and the sky went dark ~0.5° early.)
 * All quantities in planet radii.
 */
export function makeOpticalDepthLut(ra: number, hr: number, hm: number): THREE.DataTexture {
  const W = LUT_W, H = LUT_H, NS = 48;
  const data = new Uint16Array(W * H * 4);
  const h2f = (v: number) => THREE.DataUtils.toHalfFloat(Math.min(v, 60000));
  for (let j = 0; j < H; j++) {
    const r = 1 + (ra - 1) * (j / (H - 1)) + 1e-6;
    const muHor = -Math.sqrt(Math.max(0, 1 - 1 / (r * r)));
    for (let i = 0; i < W; i++) {
      const x = i / (W - 1);
      const mu = muHor + (1 - muHor) * x * x;
      // ray from (0, r, 0) towards direction with cos(zenith) = mu, to the top sphere
      const dx = Math.sqrt(Math.max(0, 1 - mu * mu)), dy = mu;
      const b = r * dy;
      const tTop = -b + Math.sqrt(Math.max(0, b * b - (r * r - ra * ra)));
      let odR = 0, odM = 0;
      const ds = tTop / NS;
      for (let k = 0; k < NS; k++) {
        const t = ds * (k + 0.5);
        const px = dx * t, py = r + dy * t;
        const hgt = Math.max(Math.hypot(px, py) - 1, 0);
        odR += Math.exp(-hgt / hr) * ds;
        odM += Math.exp(-hgt / hm) * ds;
      }
      const o = (j * W + i) * 4;
      data[o] = h2f(odR); data[o + 1] = h2f(odM); data[o + 2] = 0; data[o + 3] = h2f(1);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
/**
 * Gas giant cloud patterns (type 0 Jupiter, 1 Saturn, 2 Uranus, 3 Neptune) for a unit
 * direction in the planet's own frame. Static: the planet turns as a whole (uInvRot),
 * so the pattern can be painted into a cubemap (GasBaker) and read back cheaply.
 */
const GAS_PATTERN_GLSL = /* glsl */ `
vec3 jupiter(vec3 n, float lat, float lon){
  vec3 p = vec3(cos(lat)*cos(lon), n.y, cos(lat)*sin(lon));
  vec3 w = vec3(snoise(p*2.5), snoise(p*2.5+7.1), snoise(p*2.5+13.7));
  float t = fbm(p*vec3(5.,20.,5.) + w*0.9, 6);
  float y = n.y + 0.03*t + 0.01*snoise(p*vec3(2.,40.,2.));
  float b = sin(y*36.0)*0.5+0.5;
  float b2 = sin(y*15.0+1.7)*0.5+0.5;
  vec3 cream = vec3(0.95,0.88,0.74), tanc = vec3(0.82,0.57,0.37), brown = vec3(0.48,0.29,0.17), white = vec3(0.98,0.96,0.92);
  vec3 col = mix(cream, tanc, smoothstep(0.2,0.8,b));
  col = mix(col, brown, smoothstep(0.6,0.95,b2)*0.8);
  col = mix(col, vec3(0.62,0.6,0.6), smoothstep(0.72,0.95,abs(n.y)));
  float f = fbm(p*vec3(16.,60.,16.)+w*2.5, 5);
  col *= 0.86 + 0.26*f;
  // festoons / white ovals
  float ov = smoothstep(0.55, 0.75, snoise(p*vec3(9.,30.,9.)+w));
  col = mix(col, white, ov*0.35*smoothstep(0.3,0.0,abs(n.y+0.5)));
  // Great Red Spot
  float dl = mod(lon - 1.2 + PI, 2.0*PI) - PI;
  vec2 e = vec2(dl/0.2, (lat+0.39)/0.08);
  float r = length(e);
  if (r < 1.8){
    float ang = atan(e.y, e.x) + (1.8-r)*2.5;
    vec2 q = vec2(cos(ang), sin(ang))*r;
    float sw = fbm(vec3(q*2.5, 1.0), 4)*0.5+0.5;
    vec3 red = mix(vec3(0.72,0.32,0.18), vec3(0.9,0.58,0.42), sw);
    col = mix(col, red, smoothstep(1.0, 0.7, r));
    col = mix(col, white*0.95, smoothstep(1.25,1.0,r)*smoothstep(0.8,1.0,r)*0.55);
  }
  return col;
}
vec3 saturn(vec3 n, float lat, float lon){
  vec3 p = vec3(cos(lat)*cos(lon), n.y, cos(lat)*sin(lon));
  vec3 w = vec3(snoise(p*2.0), snoise(p*2.0+4.1), 0.0);
  float y = n.y + 0.012*fbm(p*vec3(4.,25.,4.)+w, 5);
  float b = sin(y*30.0)*0.5+0.5;
  float b2 = sin(y*11.0+0.6)*0.5+0.5;
  vec3 col = mix(vec3(0.93,0.84,0.62), vec3(0.82,0.7,0.48), b);
  col = mix(col, vec3(0.7,0.58,0.4), b2*0.35);
  col *= 0.94 + 0.1*fbm(p*vec3(12.,60.,12.)+w*2.0, 4);
  // north polar hexagon
  if (n.y > 0.85){
    float a = atan(n.z, n.x);
    float sector = PI/3.0;
    float hexr = cos(sector*0.5)/cos(mod(a, sector) - sector*0.5);
    float rr = length(n.xz)/0.42;
    float hx = smoothstep(1.03, 0.97, rr/hexr);
    col = mix(col, vec3(0.55,0.62,0.68), hx*0.7);
  }
  return col;
}
vec3 uranus(vec3 n, float lat){
  float y = n.y + 0.01*snoise(n*vec3(3.,20.,3.));
  vec3 col = vec3(0.62,0.86,0.9);
  col *= 0.97 + 0.04*sin(y*25.0);
  col = mix(col, vec3(0.75,0.92,0.94), smoothstep(0.6,0.95,n.y)*0.5);
  return col;
}
vec3 neptune(vec3 n, float lat, float lon){
  vec3 p = vec3(cos(lat)*cos(lon), n.y, cos(lat)*sin(lon));
  float y = n.y + 0.02*fbm(p*vec3(3.,18.,3.), 4);
  vec3 col = mix(vec3(0.22,0.4,0.92), vec3(0.16,0.3,0.78), sin(y*14.0)*0.5+0.5);
  float streak = smoothstep(0.45, 0.8, fbm(p*vec3(5.,60.,5.)+3.0, 4)) * smoothstep(0.25,0.0,abs(abs(n.y)-0.45));
  col = mix(col, vec3(0.95,0.97,1.0), streak*0.8);
  float dl = mod(lon - 2.5 + PI, 2.0*PI) - PI;
  vec2 e = vec2(dl/0.16, (lat+0.36)/0.07);
  float r = length(e);
  col = mix(col, vec3(0.08,0.14,0.45), smoothstep(1.0, 0.6, r));
  col = mix(col, vec3(0.9,0.95,1.0), smoothstep(1.4,1.1,r)*smoothstep(0.9,1.1,r)*0.5*step(0.0,e.y));
  return col;
}
vec3 gasPattern(vec3 n, float type){
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(n.z, n.x);
  vec3 col;
  if (type < 0.5) col = jupiter(n, lat, lon);
  else if (type < 1.5) col = saturn(n, lat, lon);
  else if (type < 2.5) col = uranus(n, lat);
  else col = neptune(n, lat, lon);
  return col;
}
`;

/**
 * Paints the nearest gas giant into a cubemap a strip per frame (no hitch), so from
 * medium range its ~20 noise evaluations per pixel become one texture read. Up close,
 * where a texel would be bigger than a pixel, the planet shader blends back to the live
 * pattern.
 */
export class GasBaker {
  rt: THREE.WebGLCubeRenderTarget;
  /** what is painted (or being painted) now; null = nothing */
  target: unknown = null;
  ready = false;
  private step = 0;
  private scene = new THREE.Scene();
  private cams: THREE.CubeCamera;
  private mat: THREE.ShaderMaterial;
  constructor(public size: number, private strips = 8) {
    this.rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.UnsignedByteType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uType: { value: 0 } },
      vertexShader: /* glsl */ `
varying vec3 vObj;
void main(){ vObj = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
#include <common>
uniform float uType;
varying vec3 vObj;
${NOISE_GLSL}
${GAS_PATTERN_GLSL}
void main(){ gl_FragColor = vec4(gasPattern(normalize(vObj), uType), 1.0); }`,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(5, 32, 16), this.mat));
    this.cams = new THREE.CubeCamera(0.1, 100, this.rt);
    this.cams.updateMatrixWorld();
  }
  /** start painting another planet */
  start(target: unknown, type: number) {
    this.target = target;
    this.mat.uniforms.uType.value = type;
    this.step = 0;
    this.ready = false;
  }
  /** paint the next strip; true once the whole cubemap is ready */
  advance(renderer: THREE.WebGLRenderer) {
    if (this.ready || this.target === null) return this.ready;
    const cams = this.cams as THREE.CubeCamera & { updateCoordinateSystem(): void };
    if (cams.coordinateSystem !== renderer.coordinateSystem) {
      cams.coordinateSystem = renderer.coordinateSystem;
      cams.updateCoordinateSystem();
    }
    const face = Math.floor(this.step / this.strips), rows = Math.ceil(this.size / this.strips);
    const prev = renderer.getRenderTarget(), prevFace = renderer.getActiveCubeFace(), prevMip = renderer.getActiveMipmapLevel();
    this.rt.scissor.set(0, (this.step % this.strips) * rows, this.size, rows);
    this.rt.scissorTest = true;
    renderer.setRenderTarget(this.rt, face);
    renderer.render(this.scene, this.cams.children[face] as THREE.Camera);
    this.rt.scissorTest = false;
    renderer.setRenderTarget(prev, prevFace, prevMip);
    if (++this.step >= 6 * this.strips) this.ready = true;
    return this.ready;
  }
}

export function makeGasMaterial(type: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: new THREE.Vector3() },
      uInvRot: { value: new THREE.Matrix3() },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunI: { value: 1 },
      uType: { value: type },
      ...eclipseUniforms(), // body-centred, planet radii
      uRingIn: { value: 0 },
      uRingOut: { value: 0 },
      /** the painted pattern (GasBaker) when it holds this planet */
      uBake: { value: null as THREE.CubeTexture | null },
      uBaked: { value: 0 },
      uBakeSize: { value: 1024 },
    },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCenter; uniform mat3 uInvRot; uniform vec3 uSunDir; uniform float uSunI; uniform float uType;
uniform float uRingIn; uniform float uRingOut;
uniform samplerCube uBake; uniform float uBaked; uniform float uBakeSize;
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
${NOISE_GLSL}
${ECLIPSE_GLSL}
${GAS_PATTERN_GLSL}
float ringDensity(float r){
  float d = 0.0;
  d += smoothstep(1.24,1.25,r)*(1.0-smoothstep(1.52,1.527,r))*0.18;
  d += smoothstep(1.525,1.53,r)*(1.0-smoothstep(1.945,1.951,r))*0.95;
  d += smoothstep(2.025,2.03,r)*(1.0-smoothstep(2.265,2.27,r))*0.6;
  return d;
}
void main(){
  #include <logdepthbuf_fragment>
  vec3 rd = normalize(vWorld);
  vec3 ro = -uCenter;
  vec2 t = rsi(ro, rd, 1.0);
  if (t.x > t.y) discard;
  float tt = t.x > 0.0 ? t.x : t.y;
  if (tt < 0.0) discard;
  vec3 pW = ro + rd*tt;
  vec3 nW = normalize(pW);
  vec3 n = normalize(uInvRot * nW);
  // the painted map where its texels are no bigger than a pixel, the live pattern up close
  float useBake = uBaked * smoothstep(0.6, 1.2, length(fwidth(pW)) * uBakeSize * 0.5);
  vec3 col = vec3(0.0);
  if (useBake < 1.0) col = gasPattern(n, uType);
  if (useBake > 0.0) col = mix(col, texture(uBake, n).rgb, useBake);
  float ndl = dot(nW, uSunDir);
  float diff = max(ndl, 0.0);
  diff = mix(diff, smoothstep(-0.08, 0.3, ndl), 0.35);
  float mu = max(dot(nW, -rd), 0.0);
  col *= mix(0.55, 1.0, pow(mu, 0.35));
  // ring shadow on planet
  if (uRingOut > 0.0){
    vec3 so = uInvRot * pW;
    vec3 sd = normalize(uInvRot * uSunDir);
    if (abs(sd.y) > 1e-4){
      float tr = -so.y / sd.y;
      if (tr > 0.0){
        vec3 hp = so + sd*tr;
        float rr = length(hp.xz);
        if (rr > uRingIn && rr < uRingOut) diff *= 1.0 - 0.85*ringDensity(rr);
      }
    }
  }
  vec3 outc = col * diff * uSunI * heliosEclipse(pW); // moons' shadows (Io on Jupiter)
  // faint night-side
  outc += col * 0.002 * uSunI;
  gl_FragColor = vec4(outc, 0.0); // alpha 0 = bloom mask (lit planet surface)
}
`,
    side: THREE.FrontSide,
  });
}

// ---------------------------------------------------------------------------
export function makeRingMaterial(type: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uPlanet: { value: new THREE.Vector3() },
      uR: { value: 1 },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunI: { value: 1 },
      uNormal: { value: new THREE.Vector3(0, 1, 0) },
      uType: { value: type },
    },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uPlanet; uniform float uR; uniform vec3 uSunDir; uniform float uSunI; uniform vec3 uNormal; uniform float uType;
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
${NOISE_GLSL}
float hash1(float x){ return fract(sin(x*12.9898)*43758.5453); }
float narrow(float r, float c, float w){ return smoothstep(c-w, c, r)*(1.0-smoothstep(c, c+w, r)); }
void main(){
  #include <logdepthbuf_fragment>
  float r = length(vObj.xy);
  float fw = fwidth(r);
  float d = 0.0;
  vec3 col;
  if (uType < 0.5){
    d += smoothstep(1.11,1.12,r)*(1.0-smoothstep(1.23,1.236,r))*0.03;
    d += smoothstep(1.236,1.25,r)*(1.0-smoothstep(1.52,1.527,r))*0.16;
    d += smoothstep(1.525,1.53,r)*(1.0-smoothstep(1.945,1.951,r))*0.92;
    d += smoothstep(2.025,2.03,r)*(1.0-smoothstep(2.265,2.27,r))*0.62;
    d *= 1.0 - narrow(r, 2.214, 0.004);
    d *= 1.0 - narrow(r, 2.26, 0.002)*0.8;
    float detail = 0.65 + 0.35*hash1(floor(r*1400.0)) * (0.6 + 0.4*sin(r*310.0));
    float aa = smoothstep(0.004, 0.0005, fw);
    d *= mix(0.85, detail, aa);
    d *= 0.85 + 0.15*sin(r*90.0);
    col = mix(vec3(0.72,0.66,0.58), vec3(0.93,0.84,0.68), smoothstep(1.4,1.9,r));
    col = mix(col, vec3(0.82,0.76,0.66), smoothstep(2.0,2.2,r));
  } else if (uType < 1.5){
    d += narrow(r,1.64,0.003)+narrow(r,1.66,0.003)+narrow(r,1.68,0.003)+narrow(r,1.79,0.003)+narrow(r,1.84,0.003)+narrow(r,1.86,0.003)+narrow(r,1.9,0.003);
    d += narrow(r,2.0,0.008)*1.5;
    d *= 0.5;
    col = vec3(0.35,0.35,0.37);
  } else {
    d += narrow(r,1.69,0.004)*0.3 + narrow(r,2.15,0.004)*0.4 + narrow(r,2.54,0.005)*0.5;
    d += smoothstep(2.15,2.2,r)*(1.0-smoothstep(2.5,2.54,r))*0.04;
    col = vec3(0.4,0.38,0.38);
  }
  if (d < 0.003) discard;
  vec3 wp = vWorld;
  vec3 pr = (wp - uPlanet) / uR;
  vec2 sh = rsi(pr, uSunDir, 1.0);
  float shadow = (sh.x > 0.0 && sh.x < sh.y) ? 0.04 : 1.0;
  float sunSide = dot(uNormal, uSunDir);
  float camSide = dot(uNormal, -normalize(wp));
  float lit = sign(sunSide) == sign(camSide) ? 1.0 : (0.25 * (1.0 - d) + 0.08);
  vec3 c = col * uSunI * 0.9 * shadow * lit * (0.25 + 0.75*abs(sunSide));
  gl_FragColor = vec4(c, clamp(d, 0.0, 1.0));
}
`,
    transparent: true,
    // bloom mask: blend the colour but leave the target's alpha (0 over planet surfaces) untouched
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
/**
 * Star photosphere. Everything evolves slowly and smoothly (seconds to minutes),
 * so it reads as a living star without any flicker: boiling convection cells,
 * drifting starspots, faculae that swell near the limb and a chromosphere rim.
 */
export function makeSunMaterial(st: StarDef) {
  const sf = st.surface;
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uI: { value: st.intensity },
      uColA: { value: new THREE.Vector3(...st.colorLimb) }, uColB: { value: new THREE.Vector3(...st.colorCenter) },
      uTint: { value: new THREE.Vector3(1, 1, 1) }, // atmospheric transmittance towards the star
      uGran: { value: sf.gran }, uSpots: { value: sf.spots }, uSpotsAll: { value: sf.spotsAll }, uFlare: { value: sf.flare }, uRot: { value: sf.rot },
    },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime; uniform float uI; uniform vec3 uColA; uniform vec3 uColB; uniform vec3 uTint;
uniform float uGran; uniform float uSpots; uniform float uSpotsAll; uniform float uFlare; uniform float uRot;
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
${NOISE_GLSL}
void main(){
  #include <logdepthbuf_fragment>
  vec3 n0 = normalize(vObj);
  // slow rotation of the whole surface about the star's axis
  float ca = cos(uTime * uRot), sa = sin(uTime * uRot);
  vec3 n = vec3(n0.x*ca - n0.z*sa, n0.y, n0.x*sa + n0.z*ca);
  vec3 V = normalize(-vWorld);
  float mu = max(dot(normalize(vNormalW), V), 0.0);
  float limb = 0.3 + 0.7*pow(mu, 0.5);
  // convection cells: two animated noise layers with contrast
  float g1 = snoise(n*70.0 + vec3(uTime*0.05, 0.0, -uTime*0.03));
  float g2 = snoise(n*150.0 + vec3(-uTime*0.08, uTime*0.04, 0.0));
  float cells = smoothstep(-0.7, 0.7, g1*0.65 + g2*0.35);
  float big = snoise(n*6.0 + uTime*0.01);
  vec3 col = mix(uColA, uColB, limb) * (1.0 - 0.5*uGran + uGran*cells + 0.08*big);
  // starspots: dark cores with a softer penumbra, drifting slowly
  float sp = snoise(n*10.0 + 2.0 + vec3(0.0, uTime*0.004, uTime*0.003));
  float lat = mix(smoothstep(0.5, 0.1, abs(n.y - 0.3*sign(n.y))), 1.0, uSpotsAll);
  float core = smoothstep(0.78 - 0.3*uSpots, 0.86 - 0.2*uSpots, sp);
  float pen = smoothstep(0.62 - 0.3*uSpots, 0.86 - 0.2*uSpots, sp);
  col *= 1.0 - (0.75*core + 0.3*pen) * lat;
  // faculae / flare regions: bright patches that swell over seconds, brighter near the limb
  float fl = snoise(n*4.0 + vec3(uTime*0.06, -uTime*0.045, uTime*0.02));
  float flare = smoothstep(0.5, 0.92, fl) * uFlare * (0.45 + 0.55*(1.0 - mu));
  col += uColB * flare * 0.9;
  // chromosphere rim
  col += uColA * pow(1.0 - mu, 4.0) * 0.7;
  gl_FragColor = vec4(col * limb * uI * uTint, 1.0);
}
`,
  });
}

/**
 * Solar storms: prominences and eruptions rising from the limb. Drawn on a shell
 * 1.35x the disc, but only where a pixel lies OUTSIDE the disc on screen (exact
 * angular test against the star centre), tapering to nothing well before the
 * shell's own silhouette, so there is never a visible rim or "shield". Some
 * longitudes erupt for tens of seconds and throw taller plumes. Cheap: a few
 * noise samples, no extra passes.
 */
export function makeCoronaMaterial(st: StarDef) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uI: { value: st.coronaIntensity },
      uCol: { value: new THREE.Vector3(...st.corona) },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uCenter: { value: new THREE.Vector3(0, 0, 1) }, // star centre relative to the camera
      uR: { value: 1 }, // disc radius
      uShell: { value: 1.35 }, // shell radius in disc radii (must match the mesh scale)
    },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime; uniform float uI; uniform vec3 uCol; uniform vec3 uTint; uniform vec3 uCenter; uniform float uR; uniform float uShell;
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
${NOISE_GLSL}
void main(){
  #include <logdepthbuf_fragment>
  // apparent distance of this pixel from the star centre, in disc radii
  vec3 dc = normalize(uCenter);
  float sinSep = length(cross(normalize(vWorld), dc));
  float sinDisc = clamp(uR / length(uCenter), 1e-6, 1.0);
  float h = (sinSep / sinDisc - 1.0) / (uShell - 1.0); // 0 at the limb, 1 at the shell edge
  if (h <= 0.0 || h >= 1.0) discard;
  vec3 n = normalize(vObj);
  float lon = atan(n.z, n.x), lat = n.y;
  // storms: some longitudes erupt for a while, slowly drifting
  float storm = smoothstep(0.45, 0.9, snoise(vec3(lon * 1.3, lat * 2.0 + 3.1, uTime * 0.025)));
  // flame filaments rising from the limb, tapering with height
  float f = fbm(vec3(lon * 7.0, lat * 7.0, uTime * 0.09), 3) * 0.5 + 0.5;
  float thr = 0.42 + h * 0.5 - storm * 0.3;
  float flame = smoothstep(thr, thr + 0.25, f);
  float a = flame * pow(1.0 - h, 1.5) * (0.5 + 0.8 * storm);
  vec3 col = mix(uCol, uCol + vec3(0.3, 0.2, 0.15), flame * 0.5); // hotter cores
  gl_FragColor = vec4(col * a * uI * uTint, 1.0);
}
`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });
}

/**
 * The cloud pattern by type (0 Earth, 1 Venus, 2 Titan) for a unit direction in the cloud
 * shell's own frame: x = cover field, y = fine detail. It used to run per pixel and frame
 * (15 noise evaluations, the most expensive thing on screen); now it is painted once
 * into a cubemap (bakeClouds) and the clouds drift by turning the shell.
 */
const CLOUD_PATTERN_GLSL = /* glsl */ `
vec2 cloudPattern(vec3 n, float type){
  vec2 r = vec2(0.0);
  if (type < 0.5){
    vec3 q = n*2.2;
    vec3 w = vec3(snoise(q), snoise(q + 5.2), snoise(q + 9.1));
    float band = 0.12*cos(abs(n.y)*PI*3.0);
    r = vec2(fbm(n*4.0 + w*0.6, 9) + band, fbm(n*40.0, 3));
  } else if (type < 1.5){
    r.x = fbm(vec3(n.x*2.5, n.y*7.0, n.z*2.5) + vec3(snoise(n*1.5))*0.9, 7);
  } else {
    r.x = fbm(vec3(n.x*2.0, n.y*6.0, n.z*2.0), 5);
  }
  return r;
}
`;
/** cover field stored in 8 bits: value / 2.4 + 0.5 */
export const CLOUD_DECODE = 2.4;

/**
 * A cubemap's first channel read back to the CPU, so the game can ask what the GPU
 * draws (is there a cloud between the player and the Sun?) and get exactly the same
 * answer as the shaders.
 */
export class CubeReadback {
  faces: Uint8Array[] = [];
  constructor(renderer: THREE.WebGLRenderer, rt: THREE.WebGLCubeRenderTarget, public size: number) {
    const buf = new Uint8Array(size * size * 4);
    for (let f = 0; f < 6; f++) {
      renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf, f);
      const face = new Uint8Array(size * size);
      for (let i = 0; i < face.length; i++) face[i] = buf[i * 4];
      this.faces.push(face);
    }
  }
  /** bilinear lookup in direction (x, y, z), 0..1, with OpenGL's cube face selection */
  sample(x: number, y: number, z: number) {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    let f: number, sc: number, tc: number, ma: number;
    if (ax >= ay && ax >= az) { f = x > 0 ? 0 : 1; sc = x > 0 ? -z : z; tc = -y; ma = ax; }
    else if (ay >= az) { f = y > 0 ? 2 : 3; sc = x; tc = y > 0 ? z : -z; ma = ay; }
    else { f = z > 0 ? 4 : 5; sc = z > 0 ? x : -x; tc = -y; ma = az; }
    const n = this.size;
    const s = ((sc / ma + 1) / 2) * n - 0.5, t = ((tc / ma + 1) / 2) * n - 0.5;
    const s0 = Math.max(0, Math.min(n - 1, Math.floor(s))), t0 = Math.max(0, Math.min(n - 1, Math.floor(t)));
    const s1 = Math.min(n - 1, s0 + 1), t1 = Math.min(n - 1, t0 + 1);
    const fs = Math.max(0, Math.min(1, s - s0)), ft = Math.max(0, Math.min(1, t - t0));
    const p = this.faces[f];
    const a = p[t0 * n + s0] + (p[t0 * n + s1] - p[t0 * n + s0]) * fs;
    const b = p[t1 * n + s0] + (p[t1 * n + s1] - p[t1 * n + s0]) * fs;
    return (a + (b - a) * ft) / 255;
  }
}

/** Paint a cloud type's pattern into a cubemap (R = cover field, G = detail). */
export function bakeClouds(renderer: THREE.WebGLRenderer, type: number, size: number): THREE.WebGLCubeRenderTarget {
  const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.UnsignedByteType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const mat = new THREE.ShaderMaterial({
    uniforms: { uType: { value: type } },
    vertexShader: /* glsl */ `
varying vec3 vObj;
void main(){ vObj = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
#include <common>
uniform float uType;
varying vec3 vObj;
${NOISE_GLSL}
${CLOUD_PATTERN_GLSL}
void main(){
  vec2 cp = cloudPattern(normalize(vObj), uType);
  gl_FragColor = vec4(cp.x / ${CLOUD_DECODE.toFixed(1)} + 0.5, cp.y * 0.5 + 0.5, 0.0, 1.0);
}`,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(5, 32, 16);
  scene.add(new THREE.Mesh(geo, mat));
  new THREE.CubeCamera(0.1, 100, rt).update(renderer, scene);
  mat.dispose();
  geo.dispose();
  return rt;
}

export function makeCloudMaterial(type: number, map: THREE.CubeTexture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunI: { value: 1 },
      uColor: { value: new THREE.Vector3(1, 1, 1) },
      uCoverage: { value: 0 },
      uOpacity: { value: 1 },
      uType: { value: type },
      uBelow: { value: 0 },
      uFade: { value: 1 },
      uCloudMap: { value: map },
      /** moonlit ambient of the player's night sky (0 on other worlds) */
      uNightAmb: { value: new THREE.Vector3() },
      ...eclipseUniforms(), // body-centred, planet radii
      /** cloud shell radius in planet radii */
      uShellR: { value: 1 },
      // the body's atmosphere (shared with its atmosphere material): sunlight reaching the deck
      uRa: { value: 1.02 }, uBetaR: { value: new THREE.Vector3() }, uBetaM: { value: 0 }, uBetaO: { value: new THREE.Vector3() },
      uLut: { value: null as THREE.Texture | null },
    },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunDir; uniform float uSunI; uniform vec3 uColor; uniform float uCoverage;
uniform float uOpacity; uniform float uType; uniform float uBelow; uniform float uFade; uniform float uShellR;
uniform samplerCube uCloudMap; uniform vec3 uNightAmb;
uniform float uRa; uniform vec3 uBetaR; uniform float uBetaM; uniform vec3 uBetaO; uniform sampler2D uLut;
${ECLIPSE_GLSL}
${SUN_TRANSMITTANCE_GLSL}
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
${NOISE_GLSL}
void main(){
  #include <logdepthbuf_fragment>
  vec2 cp = texture(uCloudMap, normalize(vObj)).rg;
  float c = (cp.x - 0.5) * ${CLOUD_DECODE.toFixed(1)};
  float d; float shade = 1.0;
  if (uType < 0.5){
    // The painted map resolves weather systems (~12 km a texel); up close (from below the
    // deck, or cloud edges from low orbit) a few kilometres of live detail break it up.
    // Faded out before it gets smaller than a pixel, so it never shimmers.
    float df = 1.0 - smoothstep(0.25, 0.6, length(fwidth(vObj)) * 600.0);
    if (df > 0.0) c += fbm(normalize(vObj) * 600.0, 3) * 0.14 * df;
    d = smoothstep(uCoverage, uCoverage + 0.32, c);
    shade = mix(1.0, 0.55, smoothstep(0.3, 1.0, d) * uBelow);
    shade *= 0.9 + 0.2 * (cp.y - 0.5);
  } else if (uType < 1.5){
    d = 1.0;
    shade = 0.82 + 0.25*c;
    if (uBelow > 0.5) shade *= 0.45;
  } else {
    d = 1.0;
    shade = 0.9 + 0.12*c;
    if (uBelow > 0.5) shade *= 0.5;
  }
  vec3 nw = normalize(vNormalW); // outward, world orientation
  float musun = dot(nw, uSunDir);
  // Sunlight at the deck: white by day, golden then pink and red as it grazes the air at
  // sunset, and gone once the deck itself is in the planet's shadow (the old soft ramp
  // kept clouds lit ~14° after sunset)
  vec3 sun = sunTransmittance(uShellR, musun) * mix(0.35, 1.0, smoothstep(0.0, 0.5, musun));
  vec3 col = uColor * shade * (sun * uSunI * heliosEclipse(nw * uShellR) + uNightAmb);
  gl_FragColor = vec4(col, d * uOpacity * uFade);
}
`,
    transparent: true,
    // bloom mask: blend the colour but leave the target's alpha (0 over planet surfaces) untouched
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
/**
 * Eclipses: up to four spheres (a world's moons, or its planet) that can hide its star.
 * Positions are relative to the body's centre, in the material's own units and
 * orientation; uEclOrigin is the body's centre in the space of the shaded positions.
 */
export function eclipseUniforms() {
  return {
    uEclOrigin: { value: new THREE.Vector3() },
    /** xyz = occluder centre relative to the body centre, w = its radius (0 = unused) */
    uOcc: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    /** direction to the star */
    uEclSun: { value: new THREE.Vector3(1, 0, 0) },
    /** angular radius of the star seen from the body (rad) */
    uEclSunR: { value: 0.005 },
  };
}
const ECLIPSE_GLSL = /* glsl */ `
uniform vec3 uEclOrigin; uniform vec4 uOcc[4]; uniform vec3 uEclSun; uniform float uEclSunR;
// Share of the star's disc still visible from p: black umbra, a penumbra that grades over
// the star's apparent size, and an annular eclipse when the occluder looks smaller.
float heliosEclipse(vec3 pos){
  vec3 p = pos - uEclOrigin;
  float vis = 1.0;
  for (int i = 0; i < 4; i++){
    if (uOcc[i].w <= 0.0) continue;
    vec3 d = uOcc[i].xyz - p;
    float dist = length(d);
    if (dot(d, uEclSun) <= 0.0) continue; // the occluder is on the far side
    float ro = asin(min(uOcc[i].w / dist, 1.0));
    float sep = asin(min(length(cross(d, uEclSun)) / dist, 1.0)); // exact for tiny angles, unlike acos
    float rs = uEclSunR;
    float cover = clamp((ro + rs - sep) / (2.0 * min(ro, rs)), 0.0, 1.0);
    vis *= 1.0 - cover * cover * (3.0 - 2.0 * cover) * min(1.0, (ro * ro) / (rs * rs));
  }
  return vis;
}
`;

/**
 * Aerial perspective (terrain and water of the world under the player). The haze gets
 * thinner with altitude, so valleys fill with it while peaks stand clear, and it takes
 * the colour of the horizon sky in its direction (computed on the CPU with the same
 * scattering model as the sky), bright and warm towards the Sun, blue away from it.
 * The vectors are given in whatever space the material's positions use.
 */
export function hazeUniforms() {
  return {
    /** extinction per metre at the ground (0 = no haze) */
    uFogDensity: { value: 0 },
    /** haze scale height (m) */
    uFogH: { value: 1500 },
    /** camera altitude above the reference sphere (m) */
    uFogCamH: { value: 0 },
    uPlanetR: { value: 1 },
    /** planet centre, local vertical at the camera and the Sun's horizontal direction */
    uHzCenter: { value: new THREE.Vector3() },
    uHzUp: { value: new THREE.Vector3(0, 1, 0) },
    uHzSunAz: { value: new THREE.Vector3(1, 0, 0) },
    /** horizon sky colour by azimuth a from the Sun: exp(A + B cos(a) + C cos(2a)) */
    uFogA: { value: new THREE.Vector3() },
    uFogB: { value: new THREE.Vector3() },
    uFogC: { value: new THREE.Vector3() },
  };
}
const HAZE_GLSL = /* glsl */ `
uniform float uFogDensity; uniform float uFogH; uniform float uFogCamH; uniform float uPlanetR;
uniform vec3 uHzCenter; uniform vec3 uHzUp; uniform vec3 uHzSunAz; uniform vec3 uFogA; uniform vec3 uFogB; uniform vec3 uFogC;
// colour and opacity of the haze between the camera (origin) and the point p
vec4 heliosHaze(vec3 p){
  float d = length(p);
  if (uFogDensity <= 0.0 || d <= 0.0) return vec4(0.0);
  float h0 = max(uFogCamH, -200.0);
  float h1 = max(length(p - uHzCenter) - uPlanetR, -200.0);
  float dh = h1 - h0;
  float e0 = exp(-h0 / uFogH), e1 = exp(-h1 / uFogH);
  float avg = abs(dh) > 1.0 ? uFogH * (e0 - e1) / dh : e0; // mean density along the ray
  float f = 1.0 - exp(-uFogDensity * d * avg);
  vec3 v = p / d;
  vec3 vh = v - uHzUp * dot(v, uHzUp);
  float c1 = dot(vh, uHzSunAz) * inversesqrt(max(dot(vh, vh), 1e-8));
  return vec4(exp(uFogA + uFogB * c1 + uFogC * (2.0 * c1 * c1 - 1.0)), f);
}
`;

export function makeWaterMaterial(deep: [number, number, number], shallow: [number, number, number]) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...hazeUniforms(),
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunColor: { value: new THREE.Vector3(3, 3, 3) },
      /** daytime sky colour; the shader fades it with the water's OWN sun elevation, so a night-side ocean seen from space stays dark */
      uSky: { value: new THREE.Vector3(0.3, 0.5, 0.8) },
      /** moonlit-sky term added where the player's night floor is active */
      uSkyNight: { value: new THREE.Vector3() },
      ...eclipseUniforms(), // camera-relative world space, metres
      uDeep: { value: new THREE.Vector3(...deep) },
      uShallow: { value: new THREE.Vector3(...shallow) },
      uTime: { value: 0 },
      uOffset: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float depth;
varying vec3 vWorld; varying vec3 vNormalW; varying float vDepth;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vDepth = depth;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSky; uniform vec3 uSkyNight; uniform vec3 uDeep; uniform vec3 uShallow;
uniform float uTime; uniform vec3 uOffset;
varying vec3 vWorld; varying vec3 vNormalW; varying float vDepth;
${HAZE_GLSL}
${ECLIPSE_GLSL}
void main(){
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormalW);
  vec3 p = vWorld + uOffset;
  float dist = length(vWorld);
  vec3 KV[10];
  KV[0] = vec3(3.,8.,5.); KV[1] = vec3(-7.,2.,11.); KV[2] = vec3(13.,-4.,6.); KV[3] = vec3(20.,9.,-15.);
  KV[4] = vec3(-31.,25.,12.); KV[5] = vec3(44.,-38.,27.); KV[6] = vec3(-70.,55.,-61.); KV[7] = vec3(97.,83.,-110.);
  KV[8] = vec3(-160.,141.,120.); KV[9] = vec3(230.,-197.,180.);
  vec3 g = vec3(0.0);
  for (int i = 0; i < 10; i++){
    vec3 k = KV[i] * (6.2831853 / 1000.0);
    float kl = length(k);
    float wl = 6.2831853 / kl;
    float fade = 1.0 - smoothstep(wl*30.0, wl*90.0, dist);
    g += (k / kl) * 0.09 * cos(dot(k, p) - uTime * sqrt(9.81 * kl)) * fade;
  }
  g -= N * dot(N, g);
  vec3 n = normalize(N - g);
  vec3 V = normalize(-vWorld);
  float ndv = max(dot(n, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  float ndl = dot(N, uSunDir);
  float sunUp = smoothstep(-0.05, 0.15, ndl);
  float dayL = smoothstep(-0.1, 0.3, ndl); // this patch of water's own daylight, not the camera's
  vec3 sky = uSky * dayL + uSkyNight;
  vec3 sunC = uSunColor * heliosEclipse(vWorld);
  vec3 body = mix(uShallow, uDeep, smoothstep(0.0, 30.0, vDepth)) * (0.06 * dayL + max(ndl, 0.0)) * sunC * 0.32;
  vec3 Hs = uSunDir + V;
  vec3 H = dot(Hs, Hs) > 1e-8 ? normalize(Hs) : N;
  float nh = max(dot(n, H), 0.0);
  float spec = pow(nh, 900.0) * 60.0 + pow(nh, 80.0) * 0.5;
  vec3 col = mix(body, sky, fres) + sunC * spec * sunUp * 0.4;
  float foam = smoothstep(1.0, 0.0, vDepth) * (0.6 + 0.4 * sin(dot(p, vec3(0.7, 0.5, 0.4)) * 3.0 + uTime * 1.7));
  col += sunC * 0.25 * foam * (0.1 * dayL + max(ndl, 0.0));
  float alpha = mix(0.4, 0.97, smoothstep(0.0, 7.0, vDepth));
  alpha = max(alpha, fres);
  vec4 hz = heliosHaze(vWorld);
  col = mix(col, hz.rgb, hz.a);
  alpha = mix(alpha, 1.0, hz.a);
  gl_FragColor = vec4(col, alpha);
}
`,
    transparent: true,
    // bloom mask: blend the colour but leave the target's alpha (0 over planet surfaces) untouched
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    depthWrite: true,
  });
}

/** Text replacements on a three.js shader chunk; warns when an anchor is missing (three changed). */
function patchChunk(src: string, edits: [string, string][]) {
  for (const [from, to] of edits) {
    if (!src.includes(from)) console.warn('[helios] shader anchor not found:', from);
    src = src.replace(from, to);
  }
  return src;
}

// ---------------------------------------------------------------------------
export function patchTerrainMaterial(mat: THREE.MeshStandardMaterial) {
  const uniforms = {
    uDetailOffset: { value: new THREE.Vector3() },
    uDetail: { value: 1 },
    /** aerial perspective, vectors in view space */
    ...hazeUniforms(),
    /** 0 by day; towards 1 at night on the ground: scotopic look (colourless, compressed contrast) */
    uNight: { value: 0 },
    /** scale of the (scene-global) hemisphere light for this body: 1 where the player is, less for other worlds */
    uHemiScale: { value: 1 },
    // The scene's directional light belongs to the ground under the player: it fades out
    // when the Sun sets there. A world seen from afar (the Moon in the night sky) is lit
    // by its own sunlight instead: uDirScale 0 and uFarSun = its irradiance.
    uDirScale: { value: 1 },
    uFarSun: { value: new THREE.Vector3() },
    /** direction towards the star, view space */
    uFarSunDir: { value: new THREE.Vector3(0, 0, 1) },
    /** eclipses of a world seen from afar (view space, metres) */
    ...eclipseUniforms(),
    // cloud shadows on the ground (Earth: define HELIOS_CLOUD_SHADOW): the cloud cubemap,
    // view space -> cloud frame, deck radius (m), cover threshold and opacity, and the
    // shadow at the camera (already in the scene light: the ground gets the ratio)
    uCloudMap: { value: null as THREE.CubeTexture | null },
    uCloudRotView: { value: new THREE.Matrix3() },
    uCloudShellR: { value: 1 },
    uCloudCov: { value: 0 },
    uCloudOpac: { value: 0 },
    uCloudCam: { value: 1 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uDetailOffset;\nvarying vec3 vDetailPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvDetailPos = (modelMatrix * vec4(transformed, 1.0)).xyz + uDetailOffset;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uDetail; uniform float uNight; uniform float uHemiScale;
uniform float uDirScale; uniform vec3 uFarSun; uniform vec3 uFarSunDir;
${ECLIPSE_GLSL}
#ifdef HELIOS_CLOUD_SHADOW
uniform samplerCube uCloudMap; uniform mat3 uCloudRotView; uniform float uCloudShellR; uniform float uCloudCov; uniform float uCloudOpac; uniform float uCloudCam;
// sunlight let through by the cloud deck above p (from the planet centre, view space)
float heliosCloudShadow(vec3 p){
  float r = length(p);
  float mu = dot(p / r, uFarSunDir);
  if (r >= uCloudShellR || mu <= 0.0) return 1.0;
  vec3 q = uCloudRotView * (p + uFarSunDir * ((uCloudShellR - r) / max(mu, 0.05)));
  float c = (texture(uCloudMap, normalize(q)).r - 0.5) * ${CLOUD_DECODE.toFixed(1)};
  return 1.0 - 0.7 * smoothstep(uCloudCov, uCloudCov + 0.32, c) * uCloudOpac;
}
#endif
${HAZE_GLSL}
varying vec3 vDetailPos;
float tHash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float tNoise(vec3 x, float per){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  vec3 a = mod(i, per), b = mod(i + 1.0, per);
  return mix(mix(mix(tHash(vec3(a.x,a.y,a.z)), tHash(vec3(b.x,a.y,a.z)), f.x),
                 mix(tHash(vec3(a.x,b.y,a.z)), tHash(vec3(b.x,b.y,a.z)), f.x), f.y),
             mix(mix(tHash(vec3(a.x,a.y,b.z)), tHash(vec3(b.x,a.y,b.z)), f.x),
                 mix(tHash(vec3(a.x,b.y,b.z)), tHash(vec3(b.x,b.y,b.z)), f.x), f.y), f.z);
}
float tDetail(vec3 p){
  return tNoise(p*0.25, 64.0)*0.5 + tNoise(p, 256.0)*0.25 + tNoise(p*4.0, 1024.0)*0.15 + tNoise(p*16.0, 4096.0)*0.08;
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float heliosDet = -1.0; // detail noise, shared with the normal perturbation below
{
  float dd = length(vViewPosition);
  float f = (1.0 - smoothstep(25.0, 600.0, dd)) * uDetail;
  if (f > 0.001){
    heliosDet = tDetail(vDetailPos);
    float n2 = tNoise(vDetailPos*0.0625, 16.0);
    diffuseColor.rgb *= mix(1.0, (0.62 + 0.75*heliosDet) * (0.85 + 0.3*n2), f);
  }
}
// Night vision: rods see no colour and compress brightness, so a moonlit forest floor
// (albedo 0.05) and snow (0.8) both read instead of one being black and the other white.
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11)) * 0.5 + 0.12), uNight);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  float dd = length(vViewPosition);
  float bf = (1.0 - smoothstep(15.0, 220.0, dd)) * uDetail;
  if (bf > 0.001){
    float hb = (heliosDet >= 0.0 ? heliosDet : tDetail(vDetailPos)) * 0.35;
    vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
    float dhx = dFdx(hb), dhy = dFdy(hb);
    vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
    float det = dot(dpdx, r1);
    vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
    vec3 pn0 = abs(det) * normal - grad;
    float pl = dot(pn0, pn0);
    vec3 pn = pl > 1e-12 ? pn0 * inversesqrt(pl) : normal;
    normal = normalize(mix(normal, pn, bf));
  }
}`,
      )
      // The hemisphere light is global to the scene, but its night floor belongs to the
      // ground the player stands on: other worlds in the sky must not pick it up.
      .replace('#include <lights_fragment_begin>', `float heliosCloudF = 1.0;
#ifdef HELIOS_CLOUD_SHADOW
heliosCloudF = heliosCloudShadow(-vViewPosition - uEclOrigin) / max(uCloudCam, 0.05);
#endif
` + patchChunk(THREE.ShaderChunk.lights_fragment_begin, [
        ['irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );',
          'irradiance += uHemiScale * getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );'],
        ['getDirectionalLightInfo( directionalLight, directLight );',
          'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= uDirScale * heliosCloudF;'],
        ['#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )',
          `#if defined( RE_Direct )
if ( uFarSun.r + uFarSun.g + uFarSun.b > 0.0 ) {
	directLight.direction = uFarSunDir;
	directLight.color = uFarSun * heliosEclipse(-vViewPosition);
	directLight.visible = true;
	RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
}
#endif
#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )`],
      ]))
      .replace(
        '#include <dithering_fragment>',
        `{
  vec4 hz = heliosHaze(-vViewPosition);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, hz.rgb, hz.a);
  gl_FragColor.a = 0.0; // bloom mask: a lit planet surface never blooms, so a bright crescent cannot glow over the night side
}
#include <dithering_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => 'terrain-v1';
  return uniforms;
}

// ---------------------------------------------------------------------------
/** 1 parsec in metres */
export const PARSEC = 3.0856775814913673e16;
/** Galactic north pole and centre in game coordinates (ecliptic J2000, +Y = north, right-handed). */
const GAL_POLE = new THREE.Vector3(-0.86767, 0.49715, 0.00035);

// Blackbody colours (sRGB 0-255, Mitchell Charity's CIE 1964 10° table) by temperature.
const BB_T = [2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 8000, 9000, 10000, 12000, 15000, 20000, 30000, 40000];
const BB_RGB = [
  [255, 137, 18], [255, 161, 72], [255, 180, 107], [255, 196, 137], [255, 209, 163], [255, 219, 186], [255, 228, 206],
  [255, 236, 224], [255, 243, 239], [255, 249, 253], [245, 243, 255], [227, 233, 255], [214, 225, 255], [204, 219, 255],
  [191, 211, 255], [179, 204, 255], [168, 197, 255], [159, 190, 255], [155, 188, 255],
];
/** Star colour from its B-V index (temperature by Ballesteros' formula), scaled to unit luminance. */
function starColor(bv: number, out: number[]) {
  const T = clamp01((4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)) - 2000) / 38000) * 38000 + 2000;
  let k = 0;
  while (k < BB_T.length - 2 && BB_T[k + 1] < T) k++;
  const f = clamp01(Math.log(T / BB_T[k]) / Math.log(BB_T[k + 1] / BB_T[k]));
  // a little more saturated than the eye's pastel impression, so star colours read on screen
  for (let c = 0; c < 3; c++) out[c] = Math.pow((BB_RGB[k][c] + (BB_RGB[k + 1][c] - BB_RGB[k][c]) * f) / 255, 1.6);
  const l = 0.3 * out[0] + 0.59 * out[1] + 0.11 * out[2];
  for (let c = 0; c < 3; c++) out[c] /= l;
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * The real night sky: every naked-eye star of the Yale Bright Star Catalogue at its real
 * position, brightness and colour, plus fainter field stars that crowd towards the
 * Milky Way. Stars with a known parallax sit at their real distance (parsecs from the
 * Sun) and the vertex shader looks at them from the player's position, so on the way to
 * Proxima the nearby ones shift and brighten: Alpha Centauri A and B blaze at magnitude
 * -6.7 in Proxima's sky, and the Sun becomes a star in Cassiopeia.
 */
export function makeStars() {
  const raw = Uint8Array.from(atob(STAR_DATA), (ch) => ch.charCodeAt(0));
  const dv = new DataView(raw.buffer);
  const FAINT = 5000;
  const count = STAR_COUNT + FAINT;
  const pos = new Float32Array(count * 3); // parsecs from the Sun
  const col = new Float32Array(count * 3);
  const mag = new Float32Array(count); // V magnitude seen from the Sun
  const c = [0, 0, 0];
  for (let i = 0; i < STAR_COUNT; i++) {
    const o = i * 8;
    const lon = (dv.getUint16(o, true) / 65535) * 2 * Math.PI;
    const lat = (dv.getUint16(o + 2, true) / 65535) * Math.PI - Math.PI / 2;
    const plx = dv.getUint16(o + 4, true); // milliarcseconds
    const d = plx > 0 ? 1000 / plx : 1000; // unknown distance: far enough never to shift
    pos[i * 3] = Math.cos(lat) * Math.cos(lon) * d;
    pos[i * 3 + 1] = Math.sin(lat) * d;
    pos[i * 3 + 2] = -Math.cos(lat) * Math.sin(lon) * d;
    mag[i] = dv.getUint8(o + 6) / 25 - 2;
    starColor(dv.getUint8(o + 7) / 100 - 0.5, c);
    col.set(c, i * 3);
  }
  // fainter field stars (V 6.5-8), the same on every start
  const rnd = mulberry32(20261018);
  let i = STAR_COUNT;
  while (i < count) {
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    const x = s * Math.cos(th), y = u, z = s * Math.sin(th);
    const b = x * GAL_POLE.x + y * GAL_POLE.y + z * GAL_POLE.z;
    if (rnd() > 0.25 + 0.75 * Math.exp(-(b * b) / 0.03)) continue;
    pos[i * 3] = x * 1000; pos[i * 3 + 1] = y * 1000; pos[i * 3 + 2] = z * 1000;
    mag[i] = 6.5 + 1.5 * Math.pow(rnd(), 0.6);
    starColor(-0.2 + rnd() * 1.6, c);
    col.set(c, i * 3);
    i++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uAlpha: { value: 1 }, uPR: { value: 1 }, uVel: { value: new THREE.Vector3(0, 0, -1) }, uDop: { value: 0 },
      /** the player's position, parsecs from the Sun */
      uViewer: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aColor; attribute float aMag; uniform float uAlpha; uniform float uPR; uniform vec3 uVel; uniform float uDop;
uniform vec3 uViewer;
varying vec3 vColor;
// Pulse-engine Doppler tint: colour only, positions never change.
// c = cosine of the angle between the star direction and the direction of travel.
vec3 dopplerTint(float c, float k){
  vec3 blue = vec3(0.62, 0.78, 1.0), red = vec3(1.0, 0.55, 0.42);
  vec3 t = c > 0.0 ? mix(vec3(1.0), blue, c) : mix(vec3(1.0), red, -c);
  return mix(vec3(1.0), t, k) * (1.0 + k * 0.55 * c);
}
void main(){
  // the star as seen from the player: direction and magnitude change with parallax
  vec3 rel = position - uViewer;
  float d = length(rel);
  vec3 dir = rel / d;
  float m = aMag + 1.50515 * log2(d / length(position)); // + 5 log10(d / d0)
  float br = clamp(0.22 * exp2(-0.53151 * (m - 6.5)), 0.08, 16.0); // 10^(-0.16 (m - 6.5))
  float sz = 1.1 + 3.2 * pow(clamp((6.5 - m) / 8.0, 0.0, 1.0), 1.3) + 2.0 * clamp((-1.5 - m) / 5.0, 0.0, 1.0);
  vColor = aColor * br * uAlpha * dopplerTint(dot(dir, uVel), uDop);
  vec4 mv = modelViewMatrix * vec4(dir, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = sz * uPR;
  #include <logdepthbuf_vertex>
}`,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main(){
  #include <logdepthbuf_fragment>
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  gl_FragColor = vec4(vColor * a, 1.0);
}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.scale.setScalar(5e13);
  pts.frustumCulled = false;
  pts.renderOrder = -10;
  return pts;
}

/**
 * The Milky Way is a static procedural image (16 noise evaluations per pixel),
 * so it is rendered once into a cubemap at start-up and sampled afterwards. At
 * 1024 px per face a texel spans 0.09°, close to a screen pixel, and the
 * nebula is soft, so the result is visually identical and ~50x cheaper.
 */
export function bakeMilkyWay(renderer: THREE.WebGLRenderer, size = 1024): THREE.CubeTexture {
  const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.UnsignedByteType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const mat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
varying vec3 vObj;
void main(){ vObj = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
#include <common>
varying vec3 vObj;
${NOISE_GLSL}
void main(){
  vec3 d = normalize(vObj);
  // real galactic north pole and centre (Sagittarius), game coordinates
  vec3 gn = vec3(-0.86767, 0.49715, 0.00035);
  vec3 core = vec3(-0.05488, -0.09648, 0.99382);
  float b = dot(d, gn);
  float band = exp(-b*b/0.01) + 0.35*exp(-b*b/0.07);
  float cb = pow(max(dot(d, core), 0.0), 3.0);
  float n = fbm(d*5.0, 6)*0.5 + 0.5;
  float n2 = fbm(d*18.0 + 4.0, 4)*0.5 + 0.5;
  float dust = smoothstep(0.42, 0.7, fbm(d*7.0 + 11.0, 6)*0.5 + 0.5) * exp(-b*b/0.003);
  vec3 col = vec3(0.5, 0.56, 0.72) * band * (0.35 + 0.9*n*n2) * (1.0 + 2.0*cb);
  col += vec3(0.95, 0.75, 0.5) * cb * band * 0.6;
  col *= 1.0 - 0.85*dust;
  gl_FragColor = vec4(col * 0.4, 1.0); // x0.4 keeps the range inside 8 bits; restored when sampled
}`,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(5, 32, 16), mat));
  const cam = new THREE.CubeCamera(0.1, 100, rt);
  const prevTM = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  cam.update(renderer, scene);
  renderer.toneMapping = prevTM;
  mat.dispose();
  return rt.texture;
}

export function makeMilkyWay(map: THREE.CubeTexture) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 1 }, uVel: { value: new THREE.Vector3(0, 0, -1) }, uDop: { value: 0 }, uMap: { value: map } },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uAlpha; uniform vec3 uVel; uniform float uDop; uniform samplerCube uMap;
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
// Pulse-engine Doppler tint: colour only, positions never change.
// c = cosine of the angle between the star direction and the direction of travel.
vec3 dopplerTint(float c, float k){
  vec3 blue = vec3(0.62, 0.78, 1.0), red = vec3(1.0, 0.55, 0.42);
  vec3 t = c > 0.0 ? mix(vec3(1.0), blue, c) : mix(vec3(1.0), red, -c);
  return mix(vec3(1.0), t, k) * (1.0 + k * 0.55 * c);
}
void main(){
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vObj);
  vec3 col = textureCube(uMap, d).rgb * 2.5;
  gl_FragColor = vec4(col * 0.05 * uAlpha * dopplerTint(dot(d, uVel), uDop), 1.0);
}`,
    side: THREE.BackSide,
    depthWrite: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), mat);
  m.scale.setScalar(8e13);
  m.frustumCulled = false;
  m.renderOrder = -11;
  return m;
}

export function makeOverlay() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Vector3() }, uAlpha: { value: 0 } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform vec3 uColor; uniform float uAlpha; void main(){ gl_FragColor = vec4(uColor, uAlpha); }',
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  m.frustumCulled = false;
  m.renderOrder = 1000;
  return m;
}

export function makePlasmaMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 }, uDir: { value: new THREE.Vector3(0, 0, -1) }, uTime: { value: 0 } },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uI; uniform vec3 uDir; uniform float uTime;
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
${NOISE_GLSL}
void main(){
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(-vWorld);
  float fr = pow(1.0 - abs(dot(N, V)), 1.5);
  float front = smoothstep(-0.3, 1.0, dot(N, uDir));
  float n = snoise(vObj*2.0 + uDir*uTime*8.0)*0.5 + 0.5;
  vec3 col = mix(vec3(1.0, 0.3, 0.08), vec3(1.0, 0.85, 0.6), front*n);
  gl_FragColor = vec4(col * fr * (0.3 + front) * uI * (0.6 + 0.6*n) * 3.0, 1.0);
}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// Post-processing hardening.
// The scene is rendered into a half-float buffer (max 65504). Extremely sharp
// speculars (ship canopy / visor reflecting the Sun) can exceed that and become
// +Inf; any NaN/Inf that reaches UnrealBloomPass is smeared by its blur mip
// chain over hundreds of pixels and tone-maps to black -> the whole screen (or
// big rectangles with straight edges) goes black. We clamp the bloom input and
// sanitize NaN/Inf before tone mapping so one bad pixel can never do that.
const SANE_GLSL = /* glsl */ `
// Comparisons are false for NaN, so NaN -> 0, +Inf -> lim. (No isnan(): the
// OutputPass is a RawShaderMaterial compiled as GLSL ES 1.00.)
float heliosSane1(float x, float lim){ return (x > 0.0) ? ((x < lim) ? x : lim) : 0.0; }
// NaN/negative -> 0 per channel, then scale the colour uniformly so its brightest
// channel is at most lim: clamping channels one by one would bleach an orange
// star's glow to white.
vec3 heliosSane(vec3 c, float lim){
  c = vec3(heliosSane1(c.r, 1.0e30), heliosSane1(c.g, 1.0e30), heliosSane1(c.b, 1.0e30));
  float m = max(c.r, max(c.g, c.b));
  return (m > lim) ? c * (lim / m) : c;
}
`;

/** Clamp + sanitize the bloom pass input. `maxValue` is the brightest value allowed to bloom. */
/**
 * three r186's hardware-PCF shadow path ignores a reversed depth buffer in two
 * places (the BASIC and VSM paths handle both): it adds the bias with the
 * normal-depth sign, so every surface self-shadows (acne), and its frustum test
 * `z <= 1.0` lets fragments beyond the shadow camera's far plane (z < 0 with
 * reversed depth) be compared against the map, where the GEQUAL comparison
 * always fails. That painted a spurious shadow strip, as wide as the shadow
 * frustum, from 2.5 km behind the player to the horizon whenever the sun was
 * low enough for the frustum to lie along the ground. Patched once, before any
 * material compiles.
 */
export function patchShadowChunk() {
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const key = 'shadowmap_pars_fragment';
  const src = chunks[key];
  if (src.includes('heliosEdge')) return; // already patched (a second Game in the same page, e.g. dev reloads)
  // anchor on the hardware-PCF getShadow() itself: the chunk has several
  // `#if defined( SHADOWMAP_TYPE_PCF )` blocks (uniform declarations, helpers)
  const a = src.indexOf('float getShadow( sampler2DShadow shadowMap');
  const b = src.indexOf('return mix( 1.0, shadow, shadowIntensity );', a);
  if (a < 0 || b < 0) { console.warn('[helios] shadow chunk layout changed; PCF reversed-depth patch skipped'); return; }
  let pcf = src.slice(a, b);
  const n0 = pcf.length;
  pcf = pcf.replace('shadowCoord.z += shadowBias;',
    `#ifdef USE_REVERSED_DEPTH_BUFFER
			shadowCoord.z -= shadowBias;
			#else
			shadowCoord.z += shadowBias;
			#endif`);
  pcf = pcf.replace('bool frustumTest = inFrustum && shadowCoord.z <= 1.0;',
    'bool frustumTest = inFrustum && shadowCoord.z <= 1.0 && shadowCoord.z >= 0.0;');
  if (pcf.length === n0) { console.warn('[helios] shadow chunk text changed; PCF reversed-depth patch skipped'); return; }
  // fade the shadow out over the last 8% of the map so the frustum's edge is never a hard line on the ground
  // (the slice ends right before the function's return statement, so the fade goes in between)
  const edgeFade = `float heliosEdge = smoothstep( 0.0, 0.08, min( min( shadowCoord.x, 1.0 - shadowCoord.x ), min( shadowCoord.y, 1.0 - shadowCoord.y ) ) );
			shadow = mix( 1.0, shadow, heliosEdge );
			`;
  chunks[key] = src.slice(0, a) + pcf + edgeFade + src.slice(b);
}

export function hardenBloomPass(bloom: UnrealBloomPass, maxValue: number) {
  const mat = bloom.materialHighPassFilter;
  (bloom.highPassUniforms as Record<string, THREE.IUniform>).heliosMax = { value: maxValue };
  mat.fragmentShader = /* glsl */ `
uniform sampler2D tDiffuse; uniform vec3 defaultColor; uniform float defaultOpacity;
uniform float luminosityThreshold; uniform float smoothWidth; uniform float heliosMax;
varying vec2 vUv;
${SANE_GLSL}
void main(){
  vec4 texel = texture2D(tDiffuse, vUv);
  texel.rgb *= texel.a; // alpha is the bloom mask: planet surfaces write 0, emissive things 1
  texel.rgb = heliosSane(texel.rgb, heliosMax);
  float v = luminance(texel.xyz);
  vec4 outputColor = vec4(defaultColor.rgb, defaultOpacity);
  float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
  gl_FragColor = mix(outputColor, texel, alpha);
}`;
  mat.needsUpdate = true;
}

/**
 * Sanitize NaN/Inf right before tone mapping (a NaN tone-maps to black) and add
 * a global colour grade (`heliosGrade`, multiplied before tone mapping) used for
 * the light-speed look: a multiplication shifts hue without washing out contrast.
 */
export function hardenOutputPass(pass: OutputPass) {
  const mat = pass.material;
  const anchor = 'gl_FragColor = texture2D( tDiffuse, vUv );';
  if (!mat.fragmentShader.includes(anchor)) return;
  (mat.uniforms as Record<string, THREE.IUniform>).heliosGrade = { value: new THREE.Vector3(1, 1, 1) };
  mat.fragmentShader = mat.fragmentShader
    .replace('void main() {', `uniform vec3 heliosGrade;\n${SANE_GLSL}\nvoid main() {`)
    .replace(anchor, `${anchor}\n\t\t\tgl_FragColor.rgb = heliosSane(gl_FragColor.rgb, 1.0e4) * heliosGrade;`);
  mat.needsUpdate = true;
}

export function radialTexture(stops: [number, string][], size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

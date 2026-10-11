import * as THREE from 'three';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

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
    },
    // Ray-march sample counts; raised by the graphics quality level (Game.applyQuality).
    defines: { ATMO_NS: 16, ATMO_NL: 6 },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCenter; uniform float uRa; uniform vec3 uSunDir; uniform vec3 uBetaR; uniform float uBetaM;
uniform float uHR; uniform float uHM; uniform float uG; uniform float uSun; uniform vec3 uMieTint; uniform float uFade;
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
${NOISE_GLSL}
void main(){
  #include <logdepthbuf_fragment>
  vec3 rd = normalize(vWorld);
  vec3 ro = -uCenter;
  vec2 a = rsi(ro, rd, uRa);
  if (a.x > a.y || a.y < 0.0) discard;
  vec2 p = rsi(ro, rd, 1.0);
  float t0 = max(a.x, 0.0);
  float t1 = a.y;
  if (p.x < p.y && p.x > 0.0) t1 = min(t1, p.x);
  const int NS = ATMO_NS;
  const int NL = ATMO_NL;
  float ds = (t1 - t0) / float(NS);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  float odR = 0.0, odM = 0.0;
  float mu = dot(rd, uSunDir);
  float phR = 3.0 / (16.0 * PI) * (1.0 + mu*mu);
  float g = uG;
  float phM = 3.0 / (8.0 * PI) * ((1.0 - g*g) * (1.0 + mu*mu)) / ((2.0 + g*g) * pow(max(1.0 + g*g - 2.0*g*mu, 1e-4), 1.5));
  for (int i = 0; i < NS; i++){
    vec3 pos = ro + rd * (t0 + ds * (float(i) + 0.5));
    float h = max(length(pos) - 1.0, 0.0);
    float hr = exp(-h / uHR) * ds;
    float hm = exp(-h / uHM) * ds;
    odR += hr; odM += hm;
    vec2 lp = rsi(pos, uSunDir, 1.0);
    if (lp.x > 0.0 && lp.x < lp.y) continue;
    vec2 la = rsi(pos, uSunDir, uRa);
    float dsl = la.y / float(NL);
    float odRl = 0.0, odMl = 0.0;
    for (int j = 0; j < NL; j++){
      vec3 pl = pos + uSunDir * dsl * (float(j) + 0.5);
      float hl = max(length(pl) - 1.0, 0.0);
      odRl += exp(-hl / uHR) * dsl;
      odMl += exp(-hl / uHM) * dsl;
    }
    vec3 tau = uBetaR * (odR + odRl) + uBetaM * 1.1 * (odM + odMl);
    vec3 att = exp(-tau);
    sumR += hr * att;
    sumM += hm * att;
  }
  vec3 col = uSun * (sumR * uBetaR * phR + sumM * uBetaM * phM * uMieTint);
  gl_FragColor = vec4(col * uFade, 1.0);
}
`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });
}

// ---------------------------------------------------------------------------
export function makeGasMaterial(type: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: new THREE.Vector3() },
      uInvRot: { value: new THREE.Matrix3() },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunI: { value: 1 },
      uTime: { value: 0 },
      uType: { value: type },
      uRingIn: { value: 0 },
      uRingOut: { value: 0 },
    },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCenter; uniform mat3 uInvRot; uniform vec3 uSunDir; uniform float uSunI; uniform float uTime; uniform float uType;
uniform float uRingIn; uniform float uRingOut;
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
${NOISE_GLSL}
float ringDensity(float r){
  float d = 0.0;
  d += smoothstep(1.24,1.25,r)*(1.0-smoothstep(1.52,1.527,r))*0.18;
  d += smoothstep(1.525,1.53,r)*(1.0-smoothstep(1.945,1.951,r))*0.95;
  d += smoothstep(2.025,2.03,r)*(1.0-smoothstep(2.265,2.27,r))*0.6;
  return d;
}
vec3 jupiter(vec3 n, float lat, float lon){
  float sh = uTime*0.0015*sin(lat*13.0);
  vec3 p = vec3(cos(lat)*cos(lon+sh), n.y, cos(lat)*sin(lon+sh));
  vec3 w = vec3(snoise(p*2.5), snoise(p*2.5+7.1), snoise(p*2.5+13.7));
  float t = fbm(p*vec3(5.,20.,5.) + w*0.9, 6);
  float y = n.y + 0.03*t + 0.01*snoise(p*vec3(2.,40.,2.));
  float b = sin(y*36.0)*0.5+0.5;
  float b2 = sin(y*15.0+1.7)*0.5+0.5;
  vec3 cream = vec3(0.93,0.87,0.76), tanc = vec3(0.8,0.6,0.42), brown = vec3(0.5,0.32,0.2), white = vec3(0.98,0.96,0.92);
  vec3 col = mix(cream, tanc, smoothstep(0.2,0.8,b));
  col = mix(col, brown, smoothstep(0.6,0.95,b2)*0.65);
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
    float ang = atan(e.y, e.x) + (1.8-r)*2.5 + uTime*0.01;
    vec2 q = vec2(cos(ang), sin(ang))*r;
    float sw = fbm(vec3(q*2.5, 1.0), 4)*0.5+0.5;
    vec3 red = mix(vec3(0.72,0.32,0.18), vec3(0.9,0.58,0.42), sw);
    col = mix(col, red, smoothstep(1.0, 0.7, r));
    col = mix(col, white*0.95, smoothstep(1.25,1.0,r)*smoothstep(0.8,1.0,r)*0.55);
  }
  return col;
}
vec3 saturn(vec3 n, float lat, float lon){
  float sh = uTime*0.001*sin(lat*10.0);
  vec3 p = vec3(cos(lat)*cos(lon+sh), n.y, cos(lat)*sin(lon+sh));
  vec3 w = vec3(snoise(p*2.0), snoise(p*2.0+4.1), 0.0);
  float y = n.y + 0.012*fbm(p*vec3(4.,25.,4.)+w, 5);
  float b = sin(y*30.0)*0.5+0.5;
  float b2 = sin(y*11.0+0.6)*0.5+0.5;
  vec3 col = mix(vec3(0.93,0.84,0.62), vec3(0.82,0.7,0.48), b);
  col = mix(col, vec3(0.7,0.58,0.4), b2*0.35);
  col *= 0.94 + 0.1*fbm(p*vec3(12.,60.,12.)+w*2.0, 4);
  // north polar hexagon
  if (n.y > 0.85){
    float a = atan(n.z, n.x) + uTime*0.0005;
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
  float sh = uTime*0.003*sin(lat*6.0);
  vec3 p = vec3(cos(lat)*cos(lon+sh), n.y, cos(lat)*sin(lon+sh));
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
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(n.z, n.x);
  vec3 col;
  if (uType < 0.5) col = jupiter(n, lat, lon);
  else if (uType < 1.5) col = saturn(n, lat, lon);
  else if (uType < 2.5) col = uranus(n, lat);
  else col = neptune(n, lat, lon);
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
  vec3 outc = col * diff * uSunI;
  // faint night-side
  outc += col * 0.002 * uSunI;
  gl_FragColor = vec4(outc, 1.0);
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
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
export function makeSunMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uI: { value: 40 } },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime; uniform float uI;
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
${NOISE_GLSL}
void main(){
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vObj);
  float g = fbm(n*70.0 + vec3(uTime*0.03), 4);
  float big = snoise(n*6.0 + uTime*0.01);
  vec3 V = normalize(-vWorld);
  float mu = max(dot(normalize(vNormalW), V), 0.0);
  float limb = 0.3 + 0.7*pow(mu, 0.5);
  vec3 col = mix(vec3(1.0,0.62,0.25), vec3(1.0,0.9,0.7), limb) * (1.0 + 0.22*g + 0.08*big);
  float spots = smoothstep(0.72, 0.8, snoise(n*14.0 + 2.0)) * smoothstep(0.5, 0.1, abs(n.y - 0.3*sign(n.y)));
  col *= 1.0 - 0.6*spots;
  gl_FragColor = vec4(col * limb * uI, 1.0);
}
`,
  });
}

// ---------------------------------------------------------------------------
export function makeCloudMaterial(type: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunI: { value: 1 },
      uTime: { value: 0 },
      uColor: { value: new THREE.Vector3(1, 1, 1) },
      uCoverage: { value: 0 },
      uOpacity: { value: 1 },
      uType: { value: type },
      uBelow: { value: 0 },
      uFade: { value: 1 },
    },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunDir; uniform float uSunI; uniform float uTime; uniform vec3 uColor; uniform float uCoverage;
uniform float uOpacity; uniform float uType; uniform float uBelow; uniform float uFade;
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
${NOISE_GLSL}
void main(){
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vObj);
  float d; float shade = 1.0;
  if (uType < 0.5){
    vec3 q = n*2.2;
    vec3 w = vec3(snoise(q + uTime*0.002), snoise(q + 5.2), snoise(q + 9.1));
    float lat = abs(n.y);
    float band = 0.12*cos(lat*PI*3.0);
    float c = fbm(n*4.0 + w*0.6, 9) + band;
    d = smoothstep(uCoverage, uCoverage + 0.32, c);
    shade = mix(1.0, 0.55, smoothstep(0.3, 1.0, d) * uBelow);
    shade *= 0.9 + 0.1*fbm(n*40.0, 3);
  } else if (uType < 1.5){
    float c = fbm(vec3(n.x*2.5, n.y*7.0, n.z*2.5) + vec3(snoise(n*1.5 + uTime*0.002))*0.9, 7);
    d = 1.0;
    shade = 0.82 + 0.25*c;
    if (uBelow > 0.5) shade *= 0.45;
  } else {
    float c = fbm(vec3(n.x*2.0, n.y*6.0, n.z*2.0), 5);
    d = 1.0;
    shade = 0.9 + 0.12*c;
    if (uBelow > 0.5) shade *= 0.5;
  }
  float ndl = dot(normalize(vNormalW), uSunDir);
  if (uBelow > 0.5) ndl = dot(normalize(vObj), uSunDir);
  float light = smoothstep(-0.25, 0.3, ndl);
  vec3 col = uColor * shade * light * uSunI;
  gl_FragColor = vec4(col, d * uOpacity * uFade);
}
`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
export function makeWaterMaterial(deep: [number, number, number], shallow: [number, number, number]) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunColor: { value: new THREE.Vector3(3, 3, 3) },
      uSky: { value: new THREE.Vector3(0.3, 0.5, 0.8) },
      uDeep: { value: new THREE.Vector3(...deep) },
      uShallow: { value: new THREE.Vector3(...shallow) },
      uTime: { value: 0 },
      uOffset: { value: new THREE.Vector3() },
      uFogColor: { value: new THREE.Vector3() },
      uFogDensity: { value: 0 },
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
uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSky; uniform vec3 uDeep; uniform vec3 uShallow;
uniform float uTime; uniform vec3 uOffset; uniform vec3 uFogColor; uniform float uFogDensity;
varying vec3 vWorld; varying vec3 vNormalW; varying float vDepth;
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
  vec3 body = mix(uShallow, uDeep, smoothstep(0.0, 30.0, vDepth)) * (0.06 + max(ndl, 0.0)) * uSunColor * 0.32;
  vec3 Hs = uSunDir + V;
  vec3 H = dot(Hs, Hs) > 1e-8 ? normalize(Hs) : N;
  float nh = max(dot(n, H), 0.0);
  float spec = pow(nh, 900.0) * 60.0 + pow(nh, 80.0) * 0.5;
  vec3 col = mix(body, uSky, fres) + uSunColor * spec * sunUp * 0.4;
  float foam = smoothstep(1.0, 0.0, vDepth) * (0.6 + 0.4 * sin(dot(p, vec3(0.7, 0.5, 0.4)) * 3.0 + uTime * 1.7));
  col += uSunColor * 0.25 * foam * (0.1 + max(ndl, 0.0));
  float alpha = mix(0.4, 0.97, smoothstep(0.0, 7.0, vDepth));
  alpha = max(alpha, fres);
  float fog = 1.0 - exp(-dist * uFogDensity);
  col = mix(col, uFogColor, fog);
  alpha = mix(alpha, 1.0, fog);
  gl_FragColor = vec4(col, alpha);
}
`,
    transparent: true,
    depthWrite: true,
  });
}

// ---------------------------------------------------------------------------
export function patchTerrainMaterial(mat: THREE.MeshStandardMaterial) {
  const uniforms = {
    uDetailOffset: { value: new THREE.Vector3() },
    uDetail: { value: 1 },
    uFogColor: { value: new THREE.Vector3() },
    uFogDensity: { value: 0 },
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
uniform float uDetail; uniform vec3 uFogColor; uniform float uFogDensity;
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
{
  float dd = length(vViewPosition);
  float f = (1.0 - smoothstep(25.0, 600.0, dd)) * uDetail;
  if (f > 0.001){
    float n = tDetail(vDetailPos);
    float n2 = tNoise(vDetailPos*0.0625, 16.0);
    diffuseColor.rgb *= mix(1.0, (0.62 + 0.75*n) * (0.85 + 0.3*n2), f);
  }
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  float dd = length(vViewPosition);
  float bf = (1.0 - smoothstep(15.0, 220.0, dd)) * uDetail;
  if (bf > 0.001){
    float hb = tDetail(vDetailPos) * 0.35;
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
      .replace(
        '#include <dithering_fragment>',
        `{
  float fogF = 1.0 - exp(-length(vViewPosition) * uFogDensity);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, fogF);
}
#include <dithering_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => 'terrain-v1';
  return uniforms;
}

// ---------------------------------------------------------------------------
export function makeStars(count: number) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const gn = new THREE.Vector3(0.2, 0.86, 0.47).normalize();
  let i = 0;
  while (i < count) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const x = s * Math.cos(th), y = u, z = s * Math.sin(th);
    const b = Math.abs(x * gn.x + y * gn.y + z * gn.z);
    // more stars near galactic plane
    if (Math.random() > 0.35 + 0.65 * Math.exp(-(b * b) / 0.05)) continue;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    const m = Math.pow(Math.random(), 7);
    const t = Math.random();
    let c: [number, number, number];
    if (t < 0.12) c = [0.65, 0.75, 1.0];
    else if (t < 0.45) c = [0.9, 0.93, 1.0];
    else if (t < 0.75) c = [1.0, 0.95, 0.85];
    else if (t < 0.92) c = [1.0, 0.82, 0.6];
    else c = [1.0, 0.65, 0.45];
    const br = 0.25 + m * 3.5;
    col[i * 3] = c[0] * br; col[i * 3 + 1] = c[1] * br; col[i * 3 + 2] = c[2] * br;
    size[i] = 1.1 + m * 3.2;
    i++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 1 }, uPR: { value: 1 } },
    vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aColor; attribute float aSize; uniform float uAlpha; uniform float uPR;
varying vec3 vColor;
void main(){
  vColor = aColor * uAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPR;
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

export function makeMilkyWay() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 1 } },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uAlpha;
varying vec3 vWorld; varying vec3 vObj; varying vec3 vNormalW;
${NOISE_GLSL}
void main(){
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vObj);
  vec3 gn = normalize(vec3(0.2, 0.86, 0.47));
  vec3 core = normalize(vec3(1.0, 0.0, 0.0) - gn * gn.x);
  float b = dot(d, gn);
  float band = exp(-b*b/0.01) + 0.35*exp(-b*b/0.07);
  float cb = pow(max(dot(d, core), 0.0), 3.0);
  float n = fbm(d*5.0, 6)*0.5 + 0.5;
  float n2 = fbm(d*18.0 + 4.0, 4)*0.5 + 0.5;
  float dust = smoothstep(0.42, 0.7, fbm(d*7.0 + 11.0, 6)*0.5 + 0.5) * exp(-b*b/0.003);
  vec3 col = vec3(0.5, 0.56, 0.72) * band * (0.35 + 0.9*n*n2) * (1.0 + 2.0*cb);
  col += vec3(0.95, 0.75, 0.5) * cb * band * 0.6;
  col *= 1.0 - 0.85*dust;
  gl_FragColor = vec4(col * 0.05 * uAlpha, 1.0);
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
vec3 heliosSane(vec3 c, float lim){ return vec3(heliosSane1(c.r, lim), heliosSane1(c.g, lim), heliosSane1(c.b, lim)); }
`;

/** Clamp + sanitize the bloom pass input. `maxValue` is the brightest value allowed to bloom. */
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
  texel.rgb = heliosSane(texel.rgb, heliosMax);
  float v = luminance(texel.xyz);
  vec4 outputColor = vec4(defaultColor.rgb, defaultOpacity);
  float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
  gl_FragColor = mix(outputColor, texel, alpha);
}`;
  mat.needsUpdate = true;
}

/** Sanitize NaN/Inf right before tone mapping (a NaN tone-maps to black). */
export function hardenOutputPass(pass: OutputPass) {
  const mat = pass.material;
  const anchor = 'gl_FragColor = texture2D( tDiffuse, vUv );';
  if (!mat.fragmentShader.includes(anchor)) return;
  mat.fragmentShader = mat.fragmentShader
    .replace('void main() {', `${SANE_GLSL}\nvoid main() {`)
    .replace(anchor, `${anchor}\n\t\t\tgl_FragColor.rgb = heliosSane(gl_FragColor.rgb, 1.0e4);`);
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

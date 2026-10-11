import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BODIES, AU, C_LIGHT, makeGenerator, type BodyDef } from './bodies';
import { PlanetTerrain } from './terrain';
import {
  makeAtmosphereMaterial, makeGasMaterial, makeRingMaterial, makeSunMaterial, makeCloudMaterial,
  makeWaterMaterial, patchTerrainMaterial, makeStars, makeMilkyWay, makeOverlay, makePlasmaMaterial, radialTexture,
} from './shaders';
import { buildShip, buildAstronaut, type ShipModel, type AstroModel } from './models';
import { clamp, smoothstep } from './noise';

interface Body {
  def: BodyDef;
  pos: THREE.Vector3;
  root: THREE.Group;
  terrain?: PlanetTerrain;
  tUniforms?: ReturnType<typeof patchTerrainMaterial>;
  waterMat?: THREE.ShaderMaterial;
  atmo?: THREE.Mesh;
  atmoMat?: THREE.ShaderMaterial;
  gasMat?: THREE.ShaderMaterial;
  ringMat?: THREE.ShaderMaterial;
  clouds?: THREE.Mesh;
  cloudMat?: THREE.ShaderMaterial;
  tiltQ: THREE.Quaternion;
  invRot: THREE.Matrix3;
  marker: HTMLDivElement;
  label: HTMLDivElement;
  collapsed: boolean;
}

export interface HudState {
  mode: 'ship' | 'foot';
  bodyId: string;
  bodyName: string;
  bodyKind: string;
  altitude: number;
  speed: number;
  warp: boolean;
  hull: number;
  suit: number;
  fuel: number;
  throttle: number;
  gravity: number;
  temperature: string;
  tempValue: number;
  pressure: number;
  composition: string;
  sunlight: number;
  targetId: string | null;
  targetName: string | null;
  targetDist: number;
  eta: number;
  hint: string;
  warnings: string[];
  notes: { id: number; text: string }[];
  dead: string | null;
  locked: boolean;
  chunks: number;
  landed: boolean;
  lights: boolean;
  inCloud: boolean;
}

const V = () => new THREE.Vector3();
const ZERO = new THREE.Vector3();
const posMod = (x: number, m: number) => ((x % m) + m) % m;

export function formatDist(m: number): string {
  const a = Math.abs(m);
  const s = m < 0 ? '−' : '';
  if (a < 1000) return `${s}${a.toFixed(0)} m`;
  if (a < 1e6) return `${s}${(a / 1000).toFixed(2)} km`;
  if (a < 0.02 * AU) return `${s}${Math.round(a / 1000).toLocaleString('es-ES')} km`;
  return `${s}${(a / AU).toFixed(3)} UA`;
}
export function formatSpeed(v: number): string {
  if (v >= 0.01 * C_LIGHT) return `${(v / C_LIGHT).toFixed(v > 10 * C_LIGHT ? 0 : 2)} c`;
  if (v >= 1000) return `${(v / 1000).toFixed(v > 1e5 ? 0 : 2)} km/s`;
  return `${v.toFixed(0)} m/s`;
}

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  bodies: Body[] = [];
  byId = new Map<string, Body>();
  sunBody!: Body;
  sunMat: THREE.ShaderMaterial;
  sunGlow: THREE.Sprite;
  sunGlow2: THREE.Sprite;
  light: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  stars: THREE.Points;
  milky: THREE.Mesh;
  overlay: THREE.Mesh;
  cloudPts: THREE.Points;
  streaks: THREE.LineSegments;
  ship: ShipModel;
  astro: AstroModel;
  plasmaMat: THREE.ShaderMaterial;

  // state
  camWorld = V();
  lastCamWorld = V();
  mode: 'ship' | 'foot' = 'ship';
  shipPos = V();
  shipVel = V();
  shipQ = new THREE.Quaternion();
  throttle = 0;
  hull = 100;
  warp = false;
  warpSpeed = 0;
  warpT = 0;
  landed = false;
  autoLand = false;
  pendingExit = false;
  playerPos = V();
  playerVel = V();
  playerFacing = new THREE.Vector3(0, 0, -1);
  camFwd = new THREE.Vector3(0, 0, -1);
  camPitch = -0.25;
  onGround = false;
  airTime = 0;
  suit = 100;
  fuel = 100;
  walkPhase = 0;
  camQ = new THREE.Quaternion();
  orbitYaw = 0;
  orbitPitch = 0;
  camDistShip = 30;
  camDistFoot = 5;
  lightsOn = false;
  target: Body | null = null;
  nearest!: Body;
  altitude = 0;
  time = 0;
  dead: string | null = null;
  notes: { id: number; text: string; t: number }[] = [];
  noteId = 0;
  warnings: string[] = [];
  pressureNow = 0;
  tempNow = 0;
  inCloud = false;
  lightning = 0;
  lastMouseMove = 0;
  pressureNotes = new Set<number>();

  // input
  keys = new Set<string>();
  pressed = new Set<string>();
  mdx = 0;
  mdy = 0;
  locked = false;
  menuOpen = false;
  onMenuToggle?: (open: boolean) => void;

  private raf = 0;
  private lastT = 0;
  private container: HTMLElement;
  private markerLayer: HTMLElement;
  private frame = 0;
  private disposed = false;
  private cloudLocal: Float32Array;
  private streakData: Float32Array;

  constructor(container: HTMLElement, markerLayer: HTMLElement) {
    this.container = container;
    this.markerLayer = markerLayer;
    const r = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    r.setSize(container.clientWidth, container.clientHeight);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);
    r.domElement.style.display = 'block';
    this.renderer = r;

    this.camera = new THREE.PerspectiveCamera(65, container.clientWidth / container.clientHeight, 0.25, 1e15);
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color(0x000000);

    const rt = new THREE.WebGLRenderTarget(container.clientWidth, container.clientHeight, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(container.clientWidth, container.clientHeight), 0.55, 0.55, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const pmrem = new THREE.PMREMGenerator(r);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    // sky
    this.stars = makeStars(14000);
    this.milky = makeMilkyWay();
    this.scene.add(this.stars, this.milky);

    // lights
    this.light = new THREE.DirectionalLight(0xffffff, 3);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.bias = -0.0004;
    this.light.shadow.normalBias = 0.08;
    this.scene.add(this.light, this.light.target);
    this.hemi = new THREE.HemisphereLight(0x88aaff, 0x332211, 0.0);
    this.scene.add(this.hemi);

    // sun
    this.sunMat = makeSunMaterial();
    const glowTex = radialTexture([[0, 'rgba(255,240,215,1)'], [0.12, 'rgba(255,220,170,0.55)'], [0.35, 'rgba(255,180,110,0.12)'], [1, 'rgba(255,150,80,0)']]);
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: new THREE.Color(2.2, 2.0, 1.7) }));
    this.sunGlow2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: new THREE.Color(0.35, 0.3, 0.25) }));
    this.sunGlow.renderOrder = 5;
    this.sunGlow2.renderOrder = 5;

    this.plasmaMat = makePlasmaMaterial();
    this.createBodies();

    // ship & astronaut
    this.ship = buildShip(env, this.plasmaMat);
    this.scene.add(this.ship.root);
    this.astro = buildAstronaut(env);
    this.astro.root.visible = false;
    this.scene.add(this.astro.root);

    // effects
    this.overlay = makeOverlay();
    this.scene.add(this.overlay);
    const N = 700;
    this.cloudLocal = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) this.cloudLocal[i] = (Math.random() - 0.5) * 400;
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(this.cloudLocal, 3));
    const puff = radialTexture([[0, 'rgba(255,255,255,0.9)'], [0.4, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']], 128);
    this.cloudPts = new THREE.Points(cg, new THREE.PointsMaterial({ size: 70, map: puff, transparent: true, depthWrite: false, opacity: 0.5, color: 0xffffff, sizeAttenuation: true }));
    this.cloudPts.frustumCulled = false;
    this.cloudPts.renderOrder = 1001;
    this.cloudPts.visible = false;
    this.scene.add(this.cloudPts);
    const S = 260;
    this.streakData = new Float32Array(S * 6);
    for (let i = 0; i < S; i++) this.respawnStreak(i, true);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(S * 6), 3));
    this.streaks = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: new THREE.Color(1.2, 1.6, 2.6), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 1002;
    this.scene.add(this.streaks);

    this.spawnStart();
    this.bindInput();
    window.addEventListener('resize', this.onResize);
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  // -------------------------------------------------------------------------
  private createBodies() {
    for (const def of BODIES) {
      const pos = V();
      if (def.parent) {
        const p = this.byId.get(def.parent)!;
        const inc = def.incl ?? 0;
        pos.set(Math.cos(def.angle) * def.orbit, Math.sin(def.angle) * def.orbit * Math.sin(inc), Math.sin(def.angle) * def.orbit * Math.cos(inc)).add(p.pos);
      } else {
        pos.set(Math.cos(def.angle) * def.orbit, 0, Math.sin(def.angle) * def.orbit);
      }
      const root = new THREE.Group();
      this.scene.add(root);
      const tiltQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), def.tilt);
      const invRot = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(tiltQ.clone().invert()));
      const marker = document.createElement('div');
      marker.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;display:none;white-space:nowrap;font-family:ui-monospace,monospace;';
      const dot = document.createElement('div');
      dot.style.cssText = `width:9px;height:9px;border:1.5px solid ${def.markerColor};transform:translate(-50%,-50%) rotate(45deg);position:absolute;left:0;top:0;`;
      const label = document.createElement('div');
      label.style.cssText = `position:absolute;left:10px;top:-7px;font-size:11px;color:${def.markerColor};text-shadow:0 0 4px #000;letter-spacing:.05em;`;
      marker.append(dot, label);
      this.markerLayer.appendChild(marker);
      const b: Body = { def, pos, root, tiltQ, invRot, marker, label, collapsed: false };

      if (def.kind === 'star') {
        const m = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.sunMat);
        m.scale.setScalar(def.radius);
        root.add(m, this.sunGlow, this.sunGlow2);
        this.sunBody = b;
      } else if (def.kind === 'gas') {
        b.gasMat = makeGasMaterial(def.gasType ?? 0);
        const m = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), b.gasMat);
        m.scale.setScalar(def.radius * 1.002);
        root.add(m);
        if (def.rings !== undefined) {
          const inner = def.rings === 0 ? 1.1 : 1.6;
          const outer = def.rings === 0 ? 2.29 : def.rings === 1 ? 2.05 : 2.6;
          b.ringMat = makeRingMaterial(def.rings);
          const rg = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 512, 4), b.ringMat);
          rg.rotation.x = -Math.PI / 2;
          rg.scale.setScalar(def.radius);
          rg.renderOrder = 3;
          const tg = new THREE.Group();
          tg.quaternion.copy(tiltQ);
          tg.add(rg);
          root.add(tg);
          b.gasMat.uniforms.uRingIn.value = def.rings === 0 ? 1.11 : 0;
          b.gasMat.uniforms.uRingOut.value = def.rings === 0 ? 2.27 : 0;
        }
      } else {
        const gen = makeGenerator(def)!;
        const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
        b.tUniforms = patchTerrainMaterial(mat);
        if (gen.seaLevel !== null) b.waterMat = makeWaterMaterial(gen.waterDeep ?? [0.02, 0.08, 0.15], gen.waterShallow ?? [0.05, 0.3, 0.35]);
        const rockMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, flatShading: true });
        const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
        b.terrain = new PlanetTerrain(def.radius, gen, mat, b.waterMat ?? null, rockMat, treeMat);
        root.add(b.terrain.group);
      }
      if (def.atmo) {
        b.atmoMat = makeAtmosphereMaterial();
        const a = def.atmo;
        const R = def.radius;
        const u = b.atmoMat.uniforms;
        u.uRa.value = 1 + a.height / R;
        u.uBetaR.value.set(a.betaR[0] * R, a.betaR[1] * R, a.betaR[2] * R);
        u.uBetaM.value = a.betaM * R;
        u.uHR.value = a.HR / R;
        u.uHM.value = a.HM / R;
        u.uG.value = a.g;
        u.uSun.value = a.sun;
        u.uMieTint.value.set(...a.mieTint);
        b.atmo = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), b.atmoMat);
        b.atmo.scale.setScalar(R + a.height);
        b.atmo.renderOrder = 4;
        root.add(b.atmo);
      }
      if (def.clouds) {
        b.cloudMat = makeCloudMaterial(def.clouds.type);
        b.cloudMat.uniforms.uColor.value.set(...def.clouds.color);
        b.cloudMat.uniforms.uCoverage.value = def.clouds.coverage;
        b.cloudMat.uniforms.uOpacity.value = def.clouds.opacity;
        b.clouds = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), b.cloudMat);
        b.clouds.scale.setScalar(def.radius + def.clouds.alt);
        b.clouds.renderOrder = 3;
        root.add(b.clouds);
      }
      this.bodies.push(b);
      this.byId.set(def.id, b);
    }
    this.nearest = this.byId.get('earth')!;
  }

  private spawnStart() {
    const earth = this.byId.get('earth')!;
    const R = earth.def.radius;
    const dir = new THREE.Vector3(-0.62, 0.32, 0.72).normalize();
    this.shipPos.copy(earth.pos).addScaledVector(dir, R + 1.9e6);
    const perp = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const tgt = earth.pos.clone().addScaledVector(perp, R * 1.05).addScaledVector(dir, R * 0.1);
    const m = new THREE.Matrix4().lookAt(this.shipPos, tgt, dir);
    this.shipQ.setFromRotationMatrix(m);
    this.camQ.copy(this.shipQ);
    this.shipVel.set(0, 0, 0);
    this.target = this.byId.get('moon')!;
  }

  // -------------------------------------------------------------------------
  private bindInput() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onLockChange);
    this.renderer.domElement.addEventListener('click', this.requestLock);
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: true });
  }
  requestLock = () => {
    if (this.menuOpen || this.dead) return;
    const el = this.renderer.domElement as HTMLCanvasElement & { requestPointerLock: () => Promise<void> | void };
    try {
      const p = el.requestPointerLock();
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
    } catch { /* ignore */ }
  };
  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.renderer.domElement;
  };
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Tab') e.preventDefault();
    if (!this.keys.has(e.code)) this.pressed.add(e.code);
    this.keys.add(e.code);
    if (e.code === 'KeyM' || e.code === 'Tab') this.toggleMenu();
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    this.mdx += e.movementX;
    this.mdy += e.movementY;
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) this.lastMouseMove = this.time;
  };
  private onWheel = (e: WheelEvent) => {
    const f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    if (this.mode === 'ship') this.camDistShip = clamp(this.camDistShip * f, 16, 120);
    else this.camDistFoot = clamp(this.camDistFoot * f, 2.2, 25);
  };
  private onResize = () => {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  toggleMenu(force?: boolean) {
    this.menuOpen = force ?? !this.menuOpen;
    if (this.menuOpen && document.pointerLockElement) document.exitPointerLock();
    this.onMenuToggle?.(this.menuOpen);
  }

  setTarget(id: string | null) {
    this.target = id ? this.byId.get(id) ?? null : null;
    if (this.target) this.note(`Destino fijado: ${this.target.def.name}. Pulsa J para el salto a velocidad luz`);
  }

  note(text: string) {
    this.notes.push({ id: ++this.noteId, text, t: this.time });
    if (this.notes.length > 5) this.notes.shift();
  }

  respawn() {
    const b = this.nearest;
    const R = b.def.radius;
    const off = Math.max(R * 0.35, (b.def.atmo?.height ?? 0) * 2.5, 60000);
    const dir = this.shipPos.clone().sub(b.pos).normalize();
    this.shipPos.copy(b.pos).addScaledVector(dir, R + off);
    const perp = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0.1)).normalize();
    const m = new THREE.Matrix4().lookAt(this.shipPos, this.shipPos.clone().add(perp), dir);
    this.shipQ.setFromRotationMatrix(m);
    this.camQ.copy(this.shipQ);
    this.shipVel.set(0, 0, 0);
    this.hull = 100;
    this.suit = 100;
    this.fuel = 100;
    this.throttle = 0;
    this.warp = false;
    this.landed = false;
    this.autoLand = false;
    this.mode = 'ship';
    this.dead = null;
    this.pressureNotes.clear();
    this.note('Nave reconstruida en órbita');
  }

  private die(reason: string) {
    if (this.dead) return;
    this.dead = reason;
    this.warp = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private respawnPlayerInShip() {
    this.mode = 'ship';
    this.suit = 100;
    this.dead = null;
    this.note('Has despertado a bordo de la nave');
  }

  revive() {
    if (!this.dead) return;
    if (this.mode === 'foot') this.respawnPlayerInShip();
    else this.respawn();
  }

  // -------------------------------------------------------------------------
  private terrainH(b: Body, dir: THREE.Vector3) {
    return b.terrain ? b.terrain.heightAt(dir.x, dir.y, dir.z) : 0;
  }

  private findNearest(p: THREE.Vector3) {
    let best = this.bodies[0], bd = Infinity;
    for (const b of this.bodies) {
      const d = p.distanceTo(b.pos) - b.def.radius;
      if (d < bd) { bd = d; best = b; }
    }
    return { body: best, alt: bd };
  }

  private dropAlt(b: Body) {
    const R = b.def.radius;
    if (b.def.kind === 'star') return R * 18;
    if (b.def.kind === 'gas') return Math.max(R * 0.8, (b.def.atmo?.height ?? 0) * 4);
    return Math.max(R * 0.9, (b.def.atmo?.height ?? 0) * 4, 4000);
  }

  private warpCap(p: THREE.Vector3) {
    let d = Infinity;
    for (const b of this.bodies) d = Math.min(d, p.distanceTo(b.pos) - b.def.radius);
    return Math.max(d, 1000) * 0.42;
  }

  // -------------------------------------------------------------------------
  private updateShip(dt: number) {
    const b = this.nearest;
    const def = b.def;
    const toC = this.shipPos.clone().sub(b.pos);
    const r = toC.length();
    const up = toC.divideScalar(r);
    const ground = def.kind === 'rocky' ? this.terrainH(b, up) : 0;
    const alt = r - def.radius - ground;
    this.altitude = alt;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.shipQ);
    const sUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.shipQ);
    const k = this.keys;
    const isGas = def.kind === 'gas';

    // rotation
    if (this.landed) {
      this.orbitYaw -= this.mdx * 0.003;
      this.orbitPitch = clamp(this.orbitPitch - this.mdy * 0.003, -1.0, 0.7);
    } else {
      const sens = 0.0021;
      const roll = (k.has('KeyA') ? 1 : 0) - (k.has('KeyD') ? 1 : 0);
      const e = new THREE.Euler(-this.mdy * sens, -this.mdx * sens, roll * 1.6 * dt, 'YXZ');
      this.shipQ.multiply(new THREE.Quaternion().setFromEuler(e)).normalize();
      this.orbitYaw *= Math.exp(-dt * 3);
      this.orbitPitch *= Math.exp(-dt * 3);
    }

    // auto-level near surfaces
    const nearSurf = !this.warp && !this.landed && (alt < Math.max(def.atmo?.height ?? 0, def.radius * 0.03)) && def.kind !== 'star';
    if (nearSurf) {
      const pu = up.clone().addScaledVector(fwd, -up.dot(fwd));
      if (pu.lengthSq() > 0.01) {
        pu.normalize();
        const ang = Math.atan2(new THREE.Vector3().crossVectors(sUp, pu).dot(fwd), sUp.dot(pu));
        const rate = (k.has('KeyA') || k.has('KeyD')) ? 0 : Math.min(1, dt * 1.2);
        this.shipQ.premultiply(new THREE.Quaternion().setFromAxisAngle(fwd, ang * rate)).normalize();
      }
    }

    // warp toggling
    if (this.pressed.has('KeyJ')) {
      if (this.warp) {
        this.warp = false;
        this.shipVel.copy(fwd).multiplyScalar(Math.min(this.warpSpeed, 2e5));
        this.note('Motor de pulso desactivado');
      } else if (this.landed) {
        this.note('Despega antes de activar el motor de pulso');
      } else if (def.atmo && alt < def.atmo.height * 0.7) {
        this.note('Sal de la atmósfera para activar el motor de pulso');
      } else if (alt < 15000 && def.kind !== 'star') {
        this.note('Demasiado cerca de la superficie para el salto');
      } else {
        this.warp = true;
        this.warpT = 0;
        this.warpSpeed = Math.max(this.shipVel.length(), 8000);
        this.note(this.target ? `Salto hacia ${this.target.def.name}` : 'Motor de pulso activado');
      }
    }

    if (this.warp) {
      this.warpT += dt;
      if (this.target && this.time - this.lastMouseMove > 0.6) {
        const want = this.target.pos.clone().sub(this.shipPos).normalize();
        const m = new THREE.Matrix4().lookAt(ZERO, want, sUp);
        const tq = new THREE.Quaternion().setFromRotationMatrix(m);
        this.shipQ.slerp(tq, 1 - Math.exp(-dt * 2.2));
      }
      const cap = this.warpCap(this.shipPos);
      this.warpSpeed = Math.min(this.warpSpeed * Math.exp(dt * 1.25), cap);
      const f2 = new THREE.Vector3(0, 0, -1).applyQuaternion(this.shipQ);
      this.shipVel.copy(f2).multiplyScalar(this.warpSpeed);
      this.shipPos.addScaledVector(this.shipVel, dt);
      this.throttle = 1;
      // drop out
      const nn = this.findNearest(this.shipPos);
      const approaching = this.shipVel.dot(nn.body.pos.clone().sub(this.shipPos)) > 0;
      const isTarget = !this.target || nn.body === this.target;
      const da = this.dropAlt(nn.body) * (isTarget ? 1 : 0.3);
      if (this.warpT > 1.2 && approaching && nn.alt < da) {
        this.warp = false;
        this.shipVel.copy(f2).multiplyScalar(Math.min(this.warpSpeed, nn.alt * 0.3));
        this.throttle = 0.6;
        if (isTarget) this.note(`Llegada: ${nn.body.def.name}`);
        else this.note(`Trayectoria obstruida por ${nn.body.def.name}. Rodéalo y vuelve a saltar`);
      }
      return;
    }

    // throttle
    if (k.has('KeyW')) this.throttle = Math.min(1, this.throttle + dt * 0.7);
    if (k.has('KeyS')) this.throttle = Math.max(-0.25, this.throttle - dt * 0.9);
    if (this.pressed.has('KeyX')) this.throttle = 0;
    const boost = k.has('ShiftLeft') || k.has('ShiftRight');
    const altEff = isGas ? Math.abs(alt) : Math.max(alt, 0);
    let maxS = clamp(altEff * 0.5, isGas ? 4000 : 30, 2.5e6);
    if (def.kind === 'star') maxS = clamp(altEff * 0.5, 1e5, 2.5e7);
    if (boost) maxS = Math.min(maxS * 3.5, 1e7);
    const vert = (k.has('Space') ? 1 : 0) - (k.has('KeyC') || k.has('KeyQ') ? 1 : 0);

    if (this.landed) {
      this.shipVel.set(0, 0, 0);
      this.hull = Math.min(100, this.hull + dt * 2);
      // align with surface
      const q = new THREE.Quaternion().setFromUnitVectors(sUp, up);
      this.shipQ.premultiply(new THREE.Quaternion().slerp(q, Math.min(1, dt * 3))).normalize();
      if (this.throttle > 0.05 || vert > 0) {
        this.landed = false;
        this.shipVel.copy(up).multiplyScalar(12);
        this.note('Despegue');
      }
    } else if (this.autoLand) {
      const q = new THREE.Quaternion().setFromUnitVectors(sUp, up);
      this.shipQ.premultiply(new THREE.Quaternion().slerp(q, Math.min(1, dt * 3))).normalize();
      this.shipVel.lerp(up.clone().multiplyScalar(-Math.min(18, alt * 1.2 + 1.5)), 1 - Math.exp(-dt * 4));
      this.throttle = 0;
    } else {
      const tv = fwd.clone().multiplyScalar(this.throttle * maxS);
      tv.addScaledVector(sUp, vert * Math.min(maxS * 0.3, 120));
      this.shipVel.lerp(tv, 1 - Math.exp(-dt * 1.6));
    }
    this.shipPos.addScaledVector(this.shipVel, dt);

    // collision
    if (def.kind === 'rocky') {
      const toC2 = this.shipPos.clone().sub(b.pos);
      const r2 = toC2.length();
      const up2 = toC2.divideScalar(r2);
      const g2 = this.terrainH(b, up2);
      const clearance = 2.75;
      const a2 = r2 - def.radius - g2;
      if (a2 < clearance) {
        this.shipPos.copy(b.pos).addScaledVector(up2, def.radius + g2 + clearance);
        const vr = this.shipVel.dot(up2);
        if (vr < 0) {
          const impact = -vr + (this.shipVel.length() > 60 ? this.shipVel.length() * 0.3 : 0);
          if (impact > 20 && !this.autoLand) {
            this.hull -= (impact - 20) * 1.2;
            this.note(`¡Impacto contra el terreno! (${impact.toFixed(0)} m/s)`);
          }
          this.shipVel.addScaledVector(up2, -vr);
        }
        if (this.shipVel.length() < 6 || this.autoLand) {
          if (!this.landed) this.note(`Aterrizaje en ${def.name}`);
          this.landed = true;
          this.autoLand = false;
          this.throttle = 0;
          if (this.pendingExit) { this.pendingExit = false; this.exitShip(); }
        }
      }
    }

    // interact
    if (this.pressed.has('KeyE')) {
      if (def.kind === 'gas') this.note('No hay superficie sólida: es un gigante gaseoso');
      else if (def.kind === 'star') this.note('No puedes aterrizar en una estrella');
      else if (this.landed) this.exitShip();
      else if (alt < 60 && this.shipVel.length() < 50) { this.autoLand = true; this.pendingExit = true; this.note('Aterrizaje automático…'); }
      else this.note('Acércate a menos de 60 m del suelo y reduce la velocidad para aterrizar');
    }
  }

  private exitShip() {
    const b = this.nearest;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.shipQ);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.shipQ);
    const p = this.shipPos.clone().addScaledVector(right, 9.5).addScaledVector(fwd, -2);
    const up = p.clone().sub(b.pos).normalize();
    p.copy(b.pos).addScaledVector(up, b.def.radius + this.terrainH(b, up) + 0.05);
    this.playerPos.copy(p);
    this.playerVel.set(0, 0, 0);
    this.camFwd.copy(fwd).addScaledVector(up, -fwd.dot(up)).normalize();
    this.playerFacing.copy(this.camFwd);
    this.camPitch = -0.2;
    this.mode = 'foot';
    this.onGround = true;
    this.fuel = 100;
    this.note(`Has bajado en ${b.def.name} · gravedad ${b.def.gravity} m/s²`);
    if (b.def.hazard?.text) this.note(`⚠ ${b.def.hazard.text}`);
  }

  private updateFoot(dt: number) {
    const b = this.nearest;
    const def = b.def;
    const up = this.playerPos.clone().sub(b.pos).normalize();
    const g = def.gravity;
    const k = this.keys;
    // camera look
    this.camFwd.applyAxisAngle(up, -this.mdx * 0.0026);
    this.camFwd.addScaledVector(up, -this.camFwd.dot(up)).normalize();
    this.camPitch = clamp(this.camPitch - this.mdy * 0.0026, -1.25, 1.0);
    this.playerFacing.addScaledVector(up, -this.playerFacing.dot(up)).normalize();
    const right = new THREE.Vector3().crossVectors(this.camFwd, up).normalize();
    const mv = new THREE.Vector3()
      .addScaledVector(this.camFwd, (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0))
      .addScaledVector(right, (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0));
    const moving = mv.lengthSq() > 0.01;
    if (moving) mv.normalize();
    const run = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = (run ? 8.5 : 4.2) * (g < 2 ? 0.8 : 1);
    const vr = this.playerVel.dot(up);
    const vt = this.playerVel.clone().addScaledVector(up, -vr);
    if (this.onGround) {
      vt.lerp(mv.clone().multiplyScalar(moving ? speed : 0), 1 - Math.exp(-dt * 10));
      this.playerVel.copy(vt);
      this.airTime = 0;
      this.fuel = Math.min(100, this.fuel + dt * 30);
      if (this.pressed.has('Space')) {
        this.playerVel.addScaledVector(up, Math.min(4.6, Math.sqrt(2 * g * 1.0) + 0.5) + (g < 2 ? 0.8 : 0));
        this.onGround = false;
      }
    } else {
      this.airTime += dt;
      vt.addScaledVector(mv, dt * 3);
      this.playerVel.copy(vt).addScaledVector(up, vr - g * dt);
      if (k.has('Space') && this.fuel > 0 && this.airTime > 0.25) {
        this.playerVel.addScaledVector(up, Math.max(g * 1.35, g + 3) * dt);
        this.playerVel.addScaledVector(mv, dt * 4);
        this.fuel = Math.max(0, this.fuel - dt * 16);
      }
    }
    for (const j of this.astro.jet) j.visible = !this.onGround && k.has('Space') && this.fuel > 0 && this.airTime > 0.25;
    this.playerPos.addScaledVector(this.playerVel, dt);
    const up2 = this.playerPos.clone().sub(b.pos);
    const r = up2.length();
    up2.divideScalar(r);
    const gr = def.radius + this.terrainH(b, up2);
    const vr2 = this.playerVel.dot(up2);
    if (r <= gr) {
      this.playerPos.copy(b.pos).addScaledVector(up2, gr);
      if (vr2 < 0) {
        if (-vr2 > 11 && !this.onGround) {
          this.suit -= (-vr2 - 11) * 6;
          this.note('¡Caída fuerte!');
        }
        this.playerVel.addScaledVector(up2, -vr2);
      }
      this.onGround = true;
    } else if (this.onGround && r - gr < 0.4 && vr2 <= 0.3) {
      this.playerPos.copy(b.pos).addScaledVector(up2, gr);
      this.playerVel.addScaledVector(up2, -vr2);
    } else {
      this.onGround = false;
    }
    this.altitude = r - gr;
    // facing / animation
    const tSpeed = vt.length();
    if (moving) this.playerFacing.lerp(mv, 1 - Math.exp(-dt * 10)).normalize();
    this.walkPhase += dt * tSpeed * (g < 2 ? 1.6 : 2.4);
    const amp = this.onGround ? Math.min(1, tSpeed / 4) : 0.25;
    const s = Math.sin(this.walkPhase);
    this.astro.legL.rotation.x = s * 0.75 * amp;
    this.astro.legR.rotation.x = -s * 0.75 * amp;
    this.astro.armL.rotation.x = -s * 0.55 * amp;
    this.astro.armR.rotation.x = s * 0.55 * amp;
    // hazards
    const drain = def.hazard?.suitDrain ?? 0.05;
    let d = drain;
    if (def.id === 'mercury') {
      const sd = this.sunBody.pos.clone().sub(this.playerPos).normalize();
      d = sd.dot(up) > 0 ? 2.2 : 0.8;
    }
    if (def.id === 'earth') d = -5;
    this.suit = clamp(this.suit - d * dt, -1, 100);
    if (this.suit <= 0) {
      this.die(def.id === 'venus' ? 'El traje colapsó bajo 92 bar de presión y 464 °C. Ningún humano podría sobrevivir en la superficie de Venus.' : `Tu traje espacial falló en ${def.name}: ${def.hazard?.text || 'daños críticos'}.`);
    }
    // re-enter ship
    if (this.pressed.has('KeyE')) {
      if (this.playerPos.distanceTo(this.shipPos) < 14) {
        this.mode = 'ship';
        this.landed = true;
        this.note('A bordo de la nave');
      } else this.note(`La nave está a ${formatDist(this.playerPos.distanceTo(this.shipPos))}`);
    }
  }

  private updateEnvironment(dt: number) {
    const b = this.nearest;
    const def = b.def;
    const p = this.mode === 'ship' ? this.shipPos : this.playerPos;
    const r = p.distanceTo(b.pos);
    const alt = this.mode === 'ship' ? this.altitude : (r - def.radius);
    const altAbs = r - def.radius;
    this.warnings = [];
    this.inCloud = false;
    if (def.kind === 'gas') {
      const depth = -altAbs;
      const P = Math.exp(depth / def.scaleHeight);
      this.pressureNow = P;
      this.tempNow = def.tempC + Math.max(0, depth) / 1000 * (def.id === 'jupiter' ? 2.0 : 1.4);
      if (this.mode === 'ship' && !this.warp) {
        for (const th of [1, 10, 23, 60, 100]) {
          if (P > th && !this.pressureNotes.has(th)) {
            this.pressureNotes.add(th);
            const msg: Record<number, string> = {
              1: `Bajo la capa de nubes de ${def.name}. No existe superficie sólida.`,
              10: 'Presión externa 10 bar. La luz solar desaparece.',
              23: 'La sonda Galileo dejó de transmitir a esta presión (1995).',
              60: 'Casco en deformación. Temperatura en aumento.',
              100: '¡Presión crítica! La nave será aplastada.',
            };
            this.note(msg[th]);
          }
        }
        if (P > 25) {
          this.hull -= dt * ((P - 25) / 130) * 22;
          this.warnings.push(`PRESIÓN EXTERNA ${P.toFixed(0)} BAR`);
        }
        if (P >= 165 || this.hull <= 0) this.die(`La nave fue aplastada por la presión a ${P.toFixed(0)} bar dentro de ${def.name}, a ${(depth / 1000).toFixed(0)} km bajo las nubes. Los gigantes gaseosos no tienen superficie: solo gas cada vez más denso y caliente hasta convertirse en un fluido.`);
      }
    } else if (def.kind === 'rocky') {
      this.pressureNow = def.pressure * Math.exp(-Math.max(0, alt) / def.scaleHeight);
      this.tempNow = def.tempC;
    } else {
      this.pressureNow = 0;
      this.tempNow = 5500;
    }
    // sun heat
    const ds = p.distanceTo(this.sunBody.pos);
    const Rs = this.sunBody.def.radius;
    if (ds < Rs * 12 && this.mode === 'ship') {
      const f = (Rs * 12) / ds;
      this.warnings.push('TEMPERATURA DEL CASCO CRÍTICA');
      this.hull -= dt * (f * f - 1) * 6;
      if (this.hull <= 0) this.die('La nave se vaporizó por el calor del Sol. A esta distancia la radiación supera los miles de grados.');
    }
    if (this.hull < 30 && !this.dead && this.mode === 'ship') this.warnings.push(`INTEGRIDAD DEL CASCO ${this.hull.toFixed(0)}%`);
    if (this.mode === 'foot' && this.suit < 40) this.warnings.push(`INTEGRIDAD DEL TRAJE ${Math.max(0, this.suit).toFixed(0)}%`);
    if (this.mode === 'ship' && this.hull <= 0) this.die('La nave quedó destruida.');
    void dt;
  }

  // -------------------------------------------------------------------------
  private updateCamera(dt: number) {
    const b = this.nearest;
    let eye: THREE.Vector3;
    let lookQ: THREE.Quaternion;
    if (this.mode === 'ship') {
      this.camQ.slerp(this.shipQ, 1 - Math.exp(-dt * (this.warp ? 4 : 7)));
      const oq = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.orbitPitch, this.orbitYaw, 0, 'YXZ'));
      const q = this.camQ.clone().multiply(oq);
      const off = new THREE.Vector3(0, this.camDistShip * 0.2, this.camDistShip).applyQuaternion(q);
      eye = this.shipPos.clone().add(off);
      lookQ = q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.1, 0, 0)));
      if (this.warp) {
        const w = Math.min(1, this.warpSpeed / (C_LIGHT * 5));
        lookQ.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.004 * w, (Math.random() - 0.5) * 0.004 * w, 0)));
      }
    } else {
      const up = this.playerPos.clone().sub(b.pos).normalize();
      const right = new THREE.Vector3().crossVectors(this.camFwd, up).normalize();
      const look = this.camFwd.clone().multiplyScalar(Math.cos(this.camPitch)).addScaledVector(up, Math.sin(this.camPitch));
      const tgt = this.playerPos.clone().addScaledVector(up, 1.55).addScaledVector(right, 0.45);
      eye = tgt.clone().addScaledVector(look, -this.camDistFoot);
      const m = new THREE.Matrix4().lookAt(ZERO, look, up);
      lookQ = new THREE.Quaternion().setFromRotationMatrix(m);
    }
    // keep camera above ground
    if (b.def.kind === 'rocky') {
      const d = eye.clone().sub(b.pos);
      const rr = d.length();
      d.divideScalar(rr);
      const minR = b.def.radius + this.terrainH(b, d) + 0.6;
      if (rr < minR) eye.copy(b.pos).addScaledVector(d, minR);
    }
    this.lastCamWorld.copy(this.camWorld);
    this.camWorld.copy(eye);
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.copy(lookQ);
    const fov = this.warp ? 65 + 18 * Math.min(1, this.warpSpeed / (C_LIGHT * 20)) : 65;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3);
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  private respawnStreak(i: number, initial: boolean) {
    const a = Math.random() * Math.PI * 2;
    const rad = 6 + Math.random() * 60;
    const z = initial ? -Math.random() * 600 : -600 - Math.random() * 100;
    const d = this.streakData;
    d[i * 6] = Math.cos(a) * rad; d[i * 6 + 1] = Math.sin(a) * rad; d[i * 6 + 2] = z;
  }

  private updateScene(dt: number) {
    const cw = this.camWorld;
    const sunPos = this.sunBody.pos;
    const sunRel = sunPos.clone().sub(cw);
    const sunDist = sunRel.length();
    const sunDir = sunRel.clone().divideScalar(sunDist);
    const b = this.nearest;
    const def = b.def;
    const camToB = cw.clone().sub(b.pos);
    const camR = camToB.length();
    const up = camToB.clone().divideScalar(camR);
    const camAlt = camR - def.radius;
    const sunEl = up.dot(sunDir);
    const dAU = sunDist / AU;
    const sunI = 3.3 * Math.pow(1 / Math.max(dAU * dAU, 0.05), 0.3);

    // body placement & uniforms
    for (const body of this.bodies) {
      body.root.position.copy(body.pos).sub(cw);
      const bR = body.def.radius;
      const bSun = sunPos.clone().sub(body.pos).normalize();
      const bAU = sunPos.distanceTo(body.pos) / AU;
      const bSunI = 3.3 * Math.pow(1 / Math.max(bAU * bAU, 0.05), 0.3);
      const rel = body.pos.clone().sub(cw);
      if (body.atmoMat) {
        const u = body.atmoMat.uniforms;
        u.uCenter.value.copy(rel).divideScalar(bR);
        u.uSunDir.value.copy(bSun);
        u.uSun.value = body.def.atmo!.sun * Math.pow(1 / Math.max(bAU * bAU, 0.05), 0.3);
        const inside = rel.length() < bR + body.def.atmo!.height;
        const side = inside ? THREE.BackSide : THREE.FrontSide;
        if (body.atmoMat.side !== side) { body.atmoMat.side = side; body.atmoMat.needsUpdate = true; }
        u.uFade.value = body.def.kind === 'gas' ? clamp(1 + (rel.length() - bR) / 3000, 0, 1) : 1;
      }
      if (body.gasMat) {
        const u = body.gasMat.uniforms;
        u.uCenter.value.copy(rel).divideScalar(bR);
        u.uInvRot.value.copy(body.invRot);
        u.uSunDir.value.copy(bSun);
        u.uSunI.value = bSunI * 0.95;
        u.uTime.value = this.time;
        const inside = rel.length() < bR * 1.002;
        const mesh = body.root.children[0] as THREE.Mesh;
        const side = inside ? THREE.BackSide : THREE.FrontSide;
        if (body.gasMat.side !== side) { body.gasMat.side = side; body.gasMat.needsUpdate = true; }
        void mesh;
      }
      if (body.ringMat) {
        const u = body.ringMat.uniforms;
        u.uPlanet.value.copy(rel);
        u.uR.value = bR;
        u.uSunDir.value.copy(bSun);
        u.uSunI.value = bSunI;
        u.uNormal.value.set(0, 1, 0).applyQuaternion(body.tiltQ);
      }
      if (body.cloudMat) {
        const u = body.cloudMat.uniforms;
        u.uSunDir.value.copy(bSun);
        u.uSunI.value = bSunI * 0.9;
        u.uTime.value = this.time;
        u.uBelow.value = rel.length() < bR + body.def.clouds!.alt ? 1 : 0;
      }
      if (body.tUniforms) {
        const u = body.tUniforms;
        u.uDetailOffset.value.set(posMod(cw.x - body.pos.x, 256), posMod(cw.y - body.pos.y, 256), posMod(cw.z - body.pos.z, 256));
        u.uFogDensity.value = 0;
      }
      if (body.waterMat) {
        const u = body.waterMat.uniforms;
        u.uOffset.value.set(posMod(cw.x - body.pos.x, 1000), posMod(cw.y - body.pos.y, 1000), posMod(cw.z - body.pos.z, 1000));
        u.uTime.value = this.time;
        u.uSunDir.value.copy(bSun);
        u.uFogDensity.value = 0;
      }
    }
    // sun
    this.sunMat.uniforms.uTime.value = this.time;
    const gs = Math.max(this.sunBody.def.radius * 9, sunDist * 0.035);
    this.sunGlow.scale.setScalar(gs);
    this.sunGlow2.scale.setScalar(gs * 4);

    // lighting at the camera / focus
    const hor = camAlt > 0 ? Math.acos(clamp(def.radius / camR, -1, 1)) : 0;
    let shadowF = def.kind === 'star' ? 1 : smoothstep(-Math.sin(hor) - 0.03, -Math.sin(hor) + 0.02, sunEl);
    if (camAlt < 3000) shadowF = 1; // near ground the shadow map handles it
    const lc = new THREE.Color(1, 1, 1);
    let li = sunI;
    let fogDensity = 0;
    const fogC = new THREE.Color(0, 0, 0);
    let hemiI = 0;
    let starAlpha = 1;
    const a = def.atmo;
    if (a && def.kind === 'rocky') {
      const dens = Math.exp(-Math.max(0, camAlt) / a.HR);
      const day = smoothstep(-0.12, 0.25, sunEl);
      const lowSun = smoothstep(0.35, -0.02, sunEl) * dens;
      if (def.id === 'earth') lc.setRGB(1, 1 - 0.45 * lowSun, 1 - 0.75 * lowSun);
      if (def.id === 'mars') lc.setRGB(1, 1 - 0.15 * lowSun, 1 - 0.25 * lowSun);
      fogDensity = a.fogDensity * dens;
      fogC.setRGB(a.fogColor[0], a.fogColor[1], a.fogColor[2]).multiplyScalar((day * 0.42 + 0.004) * sunI * Math.min(1, a.skyBrightness + 0.2));
      if (def.id === 'earth') fogC.lerp(new THREE.Color(0.9, 0.5, 0.3).multiplyScalar(sunI * 0.25), lowSun * day * 0.6);
      hemiI = day * dens * 0.9 * a.skyBrightness;
      starAlpha = 1 - day * Math.min(1, dens * 1.2) * a.skyBrightness;
      if (def.clouds && (def.id === 'venus' || def.id === 'titan')) {
        const below = camAlt < def.clouds.alt - def.clouds.thickness;
        if (below) {
          li *= def.id === 'venus' ? 0.14 : 0.1;
          lc.setRGB(1, 0.68, 0.38);
          hemiI = (def.id === 'venus' ? 1.2 : 0.8) * day;
          starAlpha = 0;
          fogC.setRGB(a.fogColor[0], a.fogColor[1], a.fogColor[2]).multiplyScalar(sunI * 0.12 * (0.15 + day));
        }
        const mid = def.clouds.alt - def.clouds.thickness / 2;
        const f = 1 - Math.abs(camAlt - mid) / (def.clouds.thickness / 2);
        if (f > 0) {
          this.inCloud = true;
          const fa = smoothstep(0, 0.35, f) * 0.96;
          this.setOverlay(new THREE.Color(...def.clouds.color).multiplyScalar(sunI * 0.32 * (0.2 + day)), fa);
        }
      }
      this.hemi.color.setRGB(a.fogColor[0], a.fogColor[1], a.fogColor[2]);
      this.hemi.groundColor.setRGB(a.fogColor[0] * 0.3, a.fogColor[1] * 0.25, a.fogColor[2] * 0.2);
    }
    if (def.kind === 'gas') {
      starAlpha = clamp(camAlt / 50000, 0, 1);
      if (camAlt < 0) {
        const depth = -camAlt;
        this.inCloud = true;
        const day = smoothstep(-0.1, 0.25, sunEl);
        if (Math.random() < dt * 0.5 && depth > 4000) this.lightning = 1;
        this.lightning = Math.max(0, this.lightning - dt * 6);
        const bright = Math.exp(-depth / 25000) * (0.1 + day) * sunI * 0.45;
        const fc = new THREE.Color(a!.fogColor[0], a!.fogColor[1], a!.fogColor[2]).multiplyScalar(bright);
        fc.add(new THREE.Color(0.6, 0.7, 1.0).multiplyScalar(this.lightning * 1.5));
        const heat = smoothstep(80000, 300000, depth);
        fc.add(new THREE.Color(0.25, 0.05, 0.0).multiplyScalar(heat));
        this.setOverlay(fc, clamp(depth / 2500, 0, 0.985));
        li *= Math.exp(-depth / 20000);
      } else if (camAlt < 20000) {
        const fc = new THREE.Color(a!.fogColor[0], a!.fogColor[1], a!.fogColor[2]).multiplyScalar(sunI * 0.4 * smoothstep(-0.1, 0.25, sunEl));
        this.setOverlay(fc, (1 - camAlt / 20000) * 0.45);
      }
    }
    if (!this.inCloud && !(def.kind === 'gas' && camAlt < 20000)) this.setOverlay(fogC, 0);
    li *= shadowF;
    this.light.color.copy(lc);
    this.light.intensity = li;
    this.hemi.intensity = hemiI;
    this.hemi.position.copy(up);
    this.stars.material instanceof THREE.ShaderMaterial && (this.stars.material.uniforms.uAlpha.value = starAlpha);
    (this.stars.material as THREE.ShaderMaterial).uniforms.uPR.value = this.renderer.getPixelRatio();
    (this.milky.material as THREE.ShaderMaterial).uniforms.uAlpha.value = starAlpha;
    if (b.tUniforms) {
      b.tUniforms.uFogDensity.value = fogDensity;
      b.tUniforms.uFogColor.value.set(fogC.r, fogC.g, fogC.b);
    }
    if (b.waterMat) {
      const u = b.waterMat.uniforms;
      u.uFogDensity.value = fogDensity;
      u.uFogColor.value.set(fogC.r, fogC.g, fogC.b);
      u.uSunColor.value.set(lc.r * li, lc.g * li, lc.b * li);
      const sky = a ? new THREE.Color(...a.fogColor).multiplyScalar(sunI * 0.3 * smoothstep(-0.1, 0.3, sunEl) + 0.005) : new THREE.Color(0, 0, 0);
      u.uSky.value.set(sky.r, sky.g, sky.b);
    }
    // ambient baseline (space is dark)
    if (!a || def.kind !== 'rocky') {
      this.hemi.color.setRGB(0.6, 0.7, 1);
      this.hemi.groundColor.setRGB(0.2, 0.2, 0.25);
      this.hemi.intensity = def.kind === 'gas' ? 0.06 : 0.025;
    }

    // shadow light follows focus
    const focus = (this.mode === 'ship' ? this.shipPos : this.playerPos).clone().sub(cw);
    this.light.position.copy(focus).addScaledVector(sunDir, 1500);
    this.light.target.position.copy(focus);
    const sc = this.light.shadow.camera;
    const ext = this.mode === 'ship' ? 70 : 45;
    if (sc.right !== ext) {
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
      sc.near = 10; sc.far = 4000;
      sc.updateProjectionMatrix();
    }
    this.light.target.updateMatrixWorld();

    // ship & astronaut
    const sm = this.ship;
    sm.root.position.copy(this.shipPos).sub(cw);
    sm.root.quaternion.copy(this.shipQ);
    const thr = this.warp ? 2.6 : Math.max(0, this.throttle) * ((this.keys.has('ShiftLeft') ? 1.7 : 1)) + (this.autoLand ? 0.3 : 0);
    for (const f of sm.flames) {
      f.visible = thr > 0.02 && this.mode === 'ship' && !this.landed;
      f.scale.set(1, 1, 0.3 + thr * 1.4 + Math.random() * 0.08);
    }
    sm.gear.visible = this.landed || this.autoLand || (this.mode === 'ship' && this.altitude < 90 && def.kind === 'rocky');
    const blink = Math.sin(this.time * 6) > 0.6;
    sm.navLights[2].visible = blink;
    sm.headlight.intensity = this.lightsOn && this.mode === 'ship' ? 260 : 0;
    // reentry plasma
    let plasma = 0;
    if (this.mode === 'ship' && a && !this.warp) {
      const dens = Math.exp(-Math.max(0, this.altitude) / a.HR) * Math.min(3, a.surfaceDensity);
      const v = this.shipVel.length();
      plasma = clamp(dens * 40 * (v - 1500) / 4000, 0, 1.2);
    }
    sm.plasma.visible = plasma > 0.02;
    if (sm.plasma.visible) {
      this.plasmaMat.uniforms.uI.value = plasma;
      this.plasmaMat.uniforms.uDir.value.copy(this.shipVel).normalize();
      this.plasmaMat.uniforms.uTime.value = this.time;
    }
    const as = this.astro;
    as.root.visible = this.mode === 'foot';
    if (this.mode === 'foot') {
      const upP = this.playerPos.clone().sub(b.pos).normalize();
      as.root.position.copy(this.playerPos).sub(cw);
      const z = this.playerFacing.clone().negate();
      const x = new THREE.Vector3().crossVectors(upP, z).normalize();
      z.crossVectors(x, upP);
      as.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, upP, z));
      as.lamp.intensity = this.lightsOn ? 28 : 0;
    } else as.lamp.intensity = 0;

    // cloud particles
    this.cloudPts.visible = this.inCloud && this.overlayAlpha > 0.05;
    if (this.cloudPts.visible) {
      const mv = this.camWorld.clone().sub(this.lastCamWorld);
      if (mv.length() > 300) mv.setLength(300);
      const arr = this.cloudLocal;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] = posMod(arr[i] - mv.x + 200, 400) - 200;
        arr[i + 1] = posMod(arr[i + 1] - mv.y + 200, 400) - 200;
        arr[i + 2] = posMod(arr[i + 2] - mv.z + 200, 400) - 200;
      }
      (this.cloudPts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      const pm = this.cloudPts.material as THREE.PointsMaterial;
      pm.color.copy(this.overlayColor).multiplyScalar(1.3);
      pm.opacity = Math.min(0.6, this.overlayAlpha * 0.6);
    }
    // warp streaks
    const wf = this.warp ? Math.min(1, this.warpSpeed / (C_LIGHT * 0.5)) : 0;
    const sMat = this.streaks.material as THREE.LineBasicMaterial;
    sMat.opacity += ((this.warp ? 0.85 * Math.max(0.15, wf) : 0) - sMat.opacity) * Math.min(1, dt * 4);
    this.streaks.visible = sMat.opacity > 0.01;
    if (this.streaks.visible) {
      const d = this.streakData;
      const out = (this.streaks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
      const vis = 900 + 3000 * wf;
      const len = 6 + 120 * wf;
      const q = this.camQ;
      const tmp = new THREE.Vector3();
      for (let i = 0; i < d.length / 6; i++) {
        d[i * 6 + 2] += vis * dt;
        if (d[i * 6 + 2] > 40) this.respawnStreak(i, false);
        tmp.set(d[i * 6], d[i * 6 + 1], d[i * 6 + 2]).applyQuaternion(q);
        out[i * 6] = tmp.x; out[i * 6 + 1] = tmp.y; out[i * 6 + 2] = tmp.z;
        tmp.set(d[i * 6], d[i * 6 + 1], d[i * 6 + 2] - len).applyQuaternion(q);
        out[i * 6 + 3] = tmp.x; out[i * 6 + 4] = tmp.y; out[i * 6 + 5] = tmp.z;
      }
      (this.streaks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  private overlayColor = new THREE.Color();
  private overlayAlpha = 0;
  private setOverlay(c: THREE.Color, a: number) {
    this.overlayColor.copy(c);
    this.overlayAlpha = a;
    const u = (this.overlay.material as THREE.ShaderMaterial).uniforms;
    u.uColor.value.set(c.r, c.g, c.b);
    u.uAlpha.value = a;
    this.overlay.visible = a > 0.001;
  }

  private updateTerrain() {
    const cw = this.camWorld;
    const sorted = this.bodies
      .filter((b) => b.terrain)
      .map((b) => ({ b, d: cw.distanceTo(b.pos) / b.def.radius }))
      .sort((x, y) => x.d - y.d);
    let first = true;
    for (const { b, d } of sorted) {
      const t = b.terrain!;
      if (d < 60) {
        const local = cw.clone().sub(b.pos);
        t.update(local, first ? 7 : 1.5);
        b.collapsed = false;
        first = false;
      } else if (!b.collapsed) {
        t.collapse();
        b.collapsed = true;
      }
    }
  }

  private updateMarkers() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const cw = this.camWorld;
    const v = new THREE.Vector3();
    const upd = this.frame % 6 === 0;
    for (const b of this.bodies) {
      v.copy(b.pos).sub(cw);
      const dist = v.length();
      const ang = b.def.radius / dist;
      const isT = this.target === b;
      const show = (ang < 0.05 || isT) && dist > b.def.radius * 1.5;
      if (!show) { b.marker.style.display = 'none'; continue; }
      v.project(this.camera);
      let x = v.x, y = v.y;
      const behind = v.z > 1 || v.z < -1;
      if (behind || Math.abs(x) > 1 || Math.abs(y) > 1) {
        if (!isT) { b.marker.style.display = 'none'; continue; }
        if (behind) { x = -x; y = -y; }
        const m = Math.max(Math.abs(x), Math.abs(y)) / 0.92;
        x /= m; y /= m;
      }
      b.marker.style.display = 'block';
      b.marker.style.transform = `translate(${((x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-y * 0.5 + 0.5) * h).toFixed(1)}px)`;
      b.marker.style.opacity = isT ? '1' : '0.7';
      (b.marker.firstChild as HTMLDivElement).style.background = isT ? b.def.markerColor : 'transparent';
      if (upd) b.label.textContent = `${isT ? '◆ ' : ''}${b.def.name.toUpperCase()}  ${formatDist(dist - b.def.radius)}`;
    }
  }

  // -------------------------------------------------------------------------
  private loop = (t: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (t - this.lastT) / 1000);
    this.lastT = t;
    this.time += dt;
    this.frame++;
    if (!this.locked) { this.mdx = 0; this.mdy = 0; }

    if (this.pressed.has('KeyF')) { this.lightsOn = !this.lightsOn; this.note(this.lightsOn ? 'Luces encendidas' : 'Luces apagadas'); }
    if (this.pressed.has('KeyT')) {
      const list = this.bodies;
      const i = this.target ? list.indexOf(this.target) : -1;
      this.setTarget(list[(i + 1) % list.length].def.id);
    }

    const focus = this.mode === 'ship' ? this.shipPos : this.playerPos;
    this.nearest = this.findNearest(focus).body;
    if (!this.dead && !this.menuOpen) {
      if (this.mode === 'ship') this.updateShip(dt);
      else this.updateFoot(dt);
      this.updateEnvironment(dt);
    }
    this.nearest = this.findNearest(this.mode === 'ship' ? this.shipPos : this.playerPos).body;
    this.updateCamera(dt);
    this.updateTerrain();
    this.updateScene(dt);
    this.updateMarkers();
    this.composer.render();
    this.mdx = 0;
    this.mdy = 0;
    this.pressed.clear();
    this.notes = this.notes.filter((n) => this.time - n.t < 7);
  };

  getHud(): HudState {
    const b = this.nearest;
    const def = b.def;
    const p = this.mode === 'ship' ? this.shipPos : this.playerPos;
    let targetDist = 0, eta = 0;
    if (this.target) {
      targetDist = p.distanceTo(this.target.pos) - this.target.def.radius;
      const drop = this.dropAlt(this.target);
      eta = Math.log(Math.max(1, targetDist / drop)) / 0.42 + (this.warp ? 0 : Math.log(Math.max(1, Math.min(targetDist, 1e11) * 0.42 / 8000)) / 1.25 * 0.5);
    }
    let hint = '';
    if (this.mode === 'ship') {
      if (this.landed) hint = 'E: bajar de la nave · W / Espacio: despegar';
      else if (def.kind === 'rocky' && this.altitude < 60) hint = 'E: aterrizar y bajar';
      else if (def.kind === 'gas' && this.altitude < 200000) hint = 'Sin superficie: descender más aumentará la presión';
    } else if (this.playerPos.distanceTo(this.shipPos) < 14) hint = 'E: subir a la nave';
    const sunD = p.distanceTo(this.sunBody.pos) / AU;
    return {
      mode: this.mode,
      bodyId: def.id,
      bodyName: def.name,
      bodyKind: def.kind === 'gas' ? 'Gigante gaseoso' : def.kind === 'star' ? 'Estrella' : def.parent ? 'Luna' : 'Planeta rocoso',
      altitude: this.altitude,
      speed: this.mode === 'ship' ? this.shipVel.length() : this.playerVel.length(),
      warp: this.warp,
      hull: Math.max(0, this.hull),
      suit: Math.max(0, this.suit),
      fuel: this.fuel,
      throttle: this.throttle,
      gravity: def.gravity,
      temperature: def.tempText,
      tempValue: this.tempNow,
      pressure: this.pressureNow,
      composition: def.composition,
      sunlight: 1 / (sunD * sunD),
      targetId: this.target?.def.id ?? null,
      targetName: this.target?.def.name ?? null,
      targetDist,
      eta,
      hint,
      warnings: this.warnings,
      notes: this.notes.map((n) => ({ id: n.id, text: n.text })),
      dead: this.dead,
      locked: this.locked,
      chunks: this.bodies.reduce((s, x) => s + (x.terrain?.chunkCount ?? 0), 0),
      landed: this.landed,
      lights: this.lightsOn,
      inCloud: this.inCloud,
    };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.markerLayer.innerHTML = '';
  }
}

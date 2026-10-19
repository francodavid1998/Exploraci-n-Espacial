import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BODIES, AU, LY, C_LIGHT, SUN_STAR, makeGenerator, type BodyDef } from './bodies';
import { PlanetTerrain } from './terrain';
import {
  makeAtmosphereMaterial, makeGasMaterial, makeRingMaterial, makeSunMaterial, makeCloudMaterial,
  makeWaterMaterial, patchTerrainMaterial, makeStars, makeMilkyWay, bakeMilkyWay, makeOverlay, makePlasmaMaterial, radialTexture, bakeClouds, CubeReadback, CLOUD_DECODE, GasBaker, makeGlints,
  hardenBloomPass, hardenOutputPass, makeCoronaMaterial, makeOpticalDepthLut, patchShadowChunk, PARSEC,
} from './shaders';
import { buildShip, buildAstronaut, type ShipModel, type AstroModel } from './models';
import { clamp, smoothstep } from './noise';
import { Survival, JUMP_COST, type GameMode, type SurvivalHud, type SurvivalSave } from './survival';
import { RuinedEarth } from './ruins';
import { AlienWorld } from './alien';
import { PLACE_INFO, PLACE_INFO_EXPLORE, LANDMARKS, GRAND_TOUR, LOGS, VEGA, VEGA_HOP, type Place } from './story';
import { SoundFX, type Mood } from './sound';
import { HUNTER_ALT } from './enemies';

interface Body {
  def: BodyDef;
  /** position in the current reference frame (relative to the star that lights the scene) */
  pos: THREE.Vector3;
  /** position relative to the body's own star (exact, small numbers) */
  local: THREE.Vector3;
  /** the star this body belongs to (a star is its own star) */
  star: Body;
  /** absolute ecliptic position of that star (Sun = origin); shared reference */
  starAbs: THREE.Vector3;
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
  /** moons / planet that can eclipse this body's star (nearest first, at most 4) */
  occluders: Body[];
  /** meshes and materials exist (worlds of other systems are built when the player heads there) */
  built: boolean;
  /** Earth-type clouds read back from the GPU (cloud shadow over the player) */
  cloudCPU?: CubeReadback;
  // stars only
  starMat?: THREE.ShaderMaterial;
  coronaMat?: THREE.ShaderMaterial;
  glow?: THREE.Sprite;
  glow2?: THREE.Sprite;
  glowBase?: THREE.Color;
  glow2Base?: THREE.Color;
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
  quality: string;
  autopilot: boolean;
  lightsMode: LightsMode;
  fastStart: boolean;
  vision: boolean;
  /** vision mode magnification (1 = no zoom) */
  zoom: number;
  gameMode: GameMode;
  /** survival mode only */
  survival: SurvivalHud | null;
  /** the nearest ruined city on Earth, when close */
  ruin: { name: string; dist: number } | null;
  /** the point chosen in the map, and how far it is (null when in another star system) */
  waypoint: { name: string; dist: number | null } | null;
  /** just hurt (0..1, fades) and where it came from (degrees on screen, 0 = ahead), both modes */
  hurt: number;
  hurtAngle: number | null;
  /** desktop: the pointer is free (Esc), the game waits */
  paused: boolean;
  /** what a pulse jump to the destination costs: seconds and (survival) fuel */
  jump: { time: number; fuel: number | null } | null;
  /** a suborbital flight to the chosen point is possible (K) or under way */
  hop: { possible: boolean; active: boolean; time: number; fuel: number | null } | null;
  /** swimming at the surface of a sea / the ship floats on it */
  swimming: boolean;
  /** first arrival at a world or place (exploration): a soft card with a few real facts */
  card: { title: string; lines: string[]; alpha: number } | null;
  /** vision mode: 'eyes' (first person, zoom) or 'exterior' (photo mode, third person) */
  visionMode: 'eyes' | 'exterior';
  sound: boolean;
  /** the jetpack can push down too (C), shown while in the air */
  airborne: boolean;
}

/**
 * Bright-light comfort setting. 'bright' is the original look; 'comfort' tones
 * down (never removes) the glow: weaker/higher-threshold bloom, lower exposure,
 * dimmer Sun disc and halo, dimmer engine flames and navigation lights.
 */
export type LightsMode = 'bright' | 'comfort';
const LIGHTS_KEY = 'helios-lights';

const V = () => new THREE.Vector3();
const ZERO = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
// scratch objects for the per-frame loops (never kept)
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m1 = new THREE.Matrix4();
/** exploration's saved place (a separate slot from survival) */
const EXPLORE_KEY = 'helios-explore-1';
const SEEN_KEY = 'helios-explore-seen';
const TOUR_KEY = 'helios-tour';
/** a sea's surface: the floor for the ship (it floats) and the astronaut (who swims) */
const SWIM_DEPTH = 1.15;
/** keys and buttons, as each device names them */
const KEY_DESK: Record<string, string> = {
  KeyE: 'E', KeyJ: 'J', KeyK: 'K', KeyT: 'T', KeyF: 'F', KeyR: 'R', KeyM: 'M', KeyG: 'G', KeyN: 'N', KeyB: 'B', KeyQ: 'Q',
  Space: 'Espacio', KeyC: 'C', Mouse0: 'clic', KeyO: 'O', KeyZ: 'Z', WeaponToggle: '1 y 2', Digit2: '2', KeyP: 'P', KeyV: 'V', KeyX: 'X',
};
const KEY_TOUCH: Record<string, string> = {
  KeyE: 'NAVE', KeyJ: 'SALTO', KeyK: 'AUTO', KeyT: 'DESTINO', KeyF: 'LUZ', KeyR: 'MINAR', KeyM: 'MAPA', KeyG: 'OPCIONES', KeyN: 'OPCIONES',
  KeyB: 'CURAR', KeyQ: 'ESQ', Space: '▲', KeyC: '▼', Mouse0: 'FUEGO', KeyO: 'VER', KeyZ: 'BALIZA', WeaponToggle: 'ARMA', Digit2: 'ARMA', KeyP: 'FOTO', KeyV: 'OPCIONES', KeyX: 'PARAR',
};
/** vision mode field of view range (degrees): 65 = normal view, 1 = Moon craters */
const VISION_FOV_MAX = 65, VISION_FOV_MIN = 1;
/** cloud deck drift by cloud type (rad/s): Earth ~20 m/s winds, Venus' super-rotation, Titan's slow air */
const CLOUD_DRIFT = [3e-6, 1.6e-5, 1e-6];
/**
 * Graphics quality ladder (index 0 = best). The game starts at the top level (phones,
 * and GPUs without the fast depth buffer, at 'Básica') and steps down automatically
 * while the frame rate stays under MIN_FPS; G cycles the levels by hand (that choice
 * is remembered and disables the automatic fallback). 'Básica' is the baseline known
 * to run well on a desktop; 'Móvil' is the floor for phones.
 */
export interface QualityLevel {
  name: string;
  /** scene buffer size relative to CSS pixels (1.5 = 2.25x the pixels: supersampling) */
  sceneScale: number;
  /** directional shadow map resolution */
  shadowMap: number;
  /** atmosphere ray-march samples along the view ray (the Sun-ray depth comes from a table;
   * the energy-conserving integration needs fewer steps than the old one for the same sky) */
  atmoSteps: number;
  /** MSAA samples of the scene buffer */
  msaa: number;
}
export const QUALITY_LEVELS: QualityLevel[] = [
  { name: 'Alta', sceneScale: 1.5, shadowMap: 4096, atmoSteps: 20, msaa: 4 },
  { name: 'Media', sceneScale: 1.25, shadowMap: 2048, atmoSteps: 16, msaa: 4 },
  { name: 'Básica', sceneScale: 1, shadowMap: 2048, atmoSteps: 12, msaa: 4 },
  { name: 'Móvil', sceneScale: 0.85, shadowMap: 1024, atmoSteps: 8, msaa: 0 },
];
/** level a phone (or a GPU on the slow logarithmic-depth path) starts at */
const QUALITY_START_LOW = 2;
/** true on touch-first devices (phones, tablets) */
export const IS_TOUCH = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
const QUALITY_KEY = 'helios-quality';
/** hemisphere-light intensity on the night side of rocky worlds: a "moonlit" grey (~30/255 on lunar soil) */
const NIGHT_AMBIENT = 0.6;
/**
 * A level must sustain (nearly) 60 fps on a 60 Hz display to be kept; otherwise step down.
 * Displays and browsers that cap the frame rate lower (50 Hz screens, battery saving at
 * 30 fps) are measured at start (see hzProbe): the bar is then 90% of what the screen shows.
 */
const MIN_FPS = 55;
const posMod = (x: number, m: number) => ((x % m) + m) % m;
const _e1 = new THREE.Vector3(), _a1 = new THREE.Vector3(), _a2 = new THREE.Vector3();
/** footsteps: darker on ice and fine dust, brighter on rock */
const STEP_TONE: Record<string, number> = {
  moon: 0.35, mars: 0.35, europa: 0.15, ganymede: 0.15, callisto: 0.2, titan: 0.25, triton: 0.15, phobos: 0.3, deimos: 0.3,
  'trappist-1f': 0.15, 'trappist-1g': 0.15, 'trappist-1h': 0.15, earth: 0.5,
};
/** each world's music is played in a key of its own (semitones) */
const WORLD_KEY: Record<string, number> = { moon: -2, mars: 3, venus: -4, mercury: 1, io: -3, europa: -1, titan: 2, triton: -5, phobos: 4, deimos: 4 };

/** writes a style only when it changes (every write can make the browser lay the page out again) */
export function css(el: HTMLElement, k: string, v: string) {
  const c = ((el as unknown as { _css?: Record<string, string> })._css ??= {});
  if (c[k] === v) return;
  c[k] = v;
  (el.style as unknown as Record<string, string>)[k] = v;
}

/** exploration's saved trip */
export interface ExploreSave {
  v: 1;
  saved: number;
  body: string;
  off: [number, number, number];
  q: [number, number, number, number];
  landed: boolean;
  target: string | null;
  waypoint: string | null;
  time?: number;
}

export function formatDist(m: number): string {
  const a = Math.abs(m);
  const s = m < 0 ? '−' : '';
  if (a < 1000) return `${s}${a.toFixed(0)} m`;
  if (a < 1e6) return `${s}${(a / 1000).toFixed(2)} km`;
  if (a < 0.02 * AU) return `${s}${Math.round(a / 1000).toLocaleString('es-ES')} km`;
  if (a >= 0.02 * LY) return `${s}${(a / LY).toFixed(2)} al`;
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
  /** true when the renderer uses a reversed float depth buffer (else logarithmic) */
  reversedDepth = false;
  /** the star lighting the scene: always the nearest star to the player */
  sunBody!: Body;
  starBodies: Body[] = [];
  light: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  stars: THREE.Points;
  /** planets and moons as points of light / the Moon's aureole (see updateGlints) */
  glints: THREE.Points;
  milky: THREE.Mesh;
  overlay: THREE.Mesh;
  cloudPts: THREE.Points;
  streaks: THREE.LineSegments;
  ship: ShipModel;
  astro: AstroModel;
  plasmaMat: THREE.ShaderMaterial;
  /** paints the gas giant that fills the view (see GasBaker) */
  private gasBaker: GasBaker;
  /** star systems whose worlds are built or queued, and the worlds still to build */
  private preparedStars = new Set<Body>();
  private buildQueue: Body[] = [];

  // state
  camWorld = V();
  lastCamWorld = V();
  /** camera position minus the followed anchor (ship or player), computed with small exact numbers */
  camOff = V();
  /** pulse-engine look: Doppler tint strength (0..1) and direction of travel */
  dop = 0;
  dopDir = new THREE.Vector3(0, 0, -1);
  private outputPass: OutputPass;
  mode: 'ship' | 'foot' = 'ship';
  shipPos = V();
  shipVel = V();
  shipQ = new THREE.Quaternion();
  throttle = 0;
  hull = 100;
  warp = false;
  warpSpeed = 0;
  warpT = 0;
  /** steer towards the selected destination while warping (K); off = free flight */
  autopilot = false;
  /** V: start a pulse jump at high speed when far from every body and the heading is clear */
  fastStart = true;
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
  lightsMode: LightsMode = 'comfort';
  /** brightness factor of glowing things for the current lights mode */
  private glowFactor = 1;
  /** tone-mapping exposure for the lights mode, and the smoothed auto-exposure factor */
  private baseExposure = 0.82;
  private autoExp = 1;
  private glowMats: { mat: THREE.Material & { color: THREE.Color }; base: THREE.Color }[] = [];
  quality = 0;
  qualityManual = false;
  private qualityWin = { t0: 0, frames: 0, bad: 0 };
  private qualityGrace = 0;
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
  /** the next distant glow in a gas giant's clouds (seconds) and the age of the current one (-1 = none) */
  private lightningNext = 5;
  private lightningAge = -1;
  lastMouseMove = 0;
  pressureNotes = new Set<number>();
  /** every sound of the game (both modes) */
  sfx = new SoundFX();
  /** time that only runs while the game does (notes age with it, not behind a paused window) */
  simTime = 0;
  /** the last notes and VEGA lines, for the map's journal */
  journal: { t: number; text: string; vega: boolean }[] = [];
  /** just hurt (0..1, fades) and the direction it came from (world, from the player) */
  hurt = 0;
  hurtDir: THREE.Vector3 | null = null;
  /** swimming at the surface (astronaut) / floating on it (ship) */
  swimming = false;
  /** a push given to the astronaut (the survival dash), applied with the collisions */
  footImpulse: { dir: THREE.Vector3; t: number; speed: number } | null = null;
  /** suborbital flight to the chosen point on the same world (K) */
  private hop: { b: Body; from: THREE.Vector3; to: THREE.Vector3; ang: number; t: number; T: number; peak: number; h0: number } | null = null;
  private airHint = false;
  /** the display's refresh rate, measured at start with a few frames that draw nothing */
  private refreshHz = 60;
  private hzProbe = { n: 0, s: [] as number[] };
  /** container size (read on resize only: reading it every frame forces layouts) */
  private cw = 1;
  private ch = 1;
  /** a photo is taken right after the next frame is drawn (P) */
  private photoPending = false;
  visionMode: 'eyes' | 'exterior' = 'eyes';
  /** exploration: first visits (cards), the grand tour, the autosave */
  private seen = new Set<string>();
  tour = new Set<string>();
  private card: { title: string; lines: string[]; t: number } | null = null;
  private exploreSaveT = 0;
  /** the sunset/sunrise point chosen in the map */
  private sunsetWp: { body: Body; dir: THREE.Vector3 } | null = null;
  /** the waypoint was chosen by the player (a distress signal must not replace it) */
  waypointUser = false;
  private pmrem!: THREE.PMREMGenerator;
  /** the ship rests on a roof (not on the ground under it) */
  private onRoof = false;
  private plasmaI = 0;
  private stepPhase = 0;
  /** what the place takes from the suit (per second; negative heals) */
  suitDrain = 0;

  // input
  keys = new Set<string>();
  pressed = new Set<string>();
  mdx = 0;
  mdy = 0;
  locked = false;
  menuOpen = false;
  /** touch controls instead of mouse + pointer lock (phones, tablets) */
  touchMode = false;
  /** vision mode: clean view of the sky, first person, zoom (see toggleVision) */
  vision = false;
  private visionFov = 65;
  onVisionToggle?: (on: boolean) => void;
  /** side of the painted cubemaps (clouds, gas giants, Milky Way) */
  private bakeSize = 1024;
  /** false while the title screen is up: the simulation stays paused and M / Tab cannot open the map */
  started = false;
  /** 'explore' = the realistic simulator exactly as it is; 'survival' adds life support, fuel, mining... */
  gameMode: GameMode = 'explore';
  /** survival-mode state and rules (null in realistic exploration) */
  surv: Survival | null = null;
  /** Earth's ruined cities (part of the world in both modes) */
  ruins!: RuinedEarth;
  /** the places of the signal: Base Tsiolkovsky, the monoliths, the Spire (both modes) */
  alien!: AlienWorld;
  /** a point on a world chosen in the map (a ruin, a mission place): marked on the ground */
  waypoint: { id: string; name: string } | null = null;
  private wpMarker!: HTMLDivElement;
  private wpLabel!: HTMLDivElement;
  private wpArrow!: HTMLDivElement;
  private wpDist: number | null = null;
  onMenuToggle?: (open: boolean) => void;
  /** lets the title screen's lights button follow the L key */
  onLightsModeChange?: (mode: LightsMode) => void;

  private raf = 0;
  private lastT = 0;
  private container: HTMLElement;
  private markerLayer: HTMLElement;
  frame = 0;
  private disposed = false;
  private cloudLocal: Float32Array;
  private streakData: Float32Array;

  constructor(container: HTMLElement, markerLayer: HTMLElement) {
    this.container = container;
    this.markerLayer = markerLayer;
    // Depth strategy. A reversed 32-bit float depth buffer keeps millimetre-to-
    // light-year precision like the logarithmic buffer did, but without every
    // shader writing gl_FragDepth, which disabled early depth rejection: the sky
    // shaders (atmosphere, clouds, Milky Way) were shaded on every pixel even
    // where terrain hides them. Falls back to the logarithmic buffer on GPUs
    // without EXT_clip_control.
    const reversedDepth = (() => {
      // escape hatch for comparisons / driver trouble: ?logdepth=1 forces the old path
      if (new URLSearchParams(location.search).has('logdepth')) return false;
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      const ok = !!gl && !!gl.getExtension('EXT_clip_control');
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return ok;
    })();
    this.reversedDepth = reversedDepth;
    patchShadowChunk();
    const r = new THREE.WebGLRenderer({ antialias: false, reversedDepthBuffer: reversedDepth, logarithmicDepthBuffer: !reversedDepth, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    r.setSize(container.clientWidth, container.clientHeight);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    // the Sun's shadow map is drawn only while the Sun really lights the scene (see loop):
    // at night its light is 0 but three would still draw the whole map every frame
    r.shadowMap.autoUpdate = false;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);
    r.domElement.style.display = 'block';
    this.renderer = r;

    this.camera = new THREE.PerspectiveCamera(65, container.clientWidth / container.clientHeight, 0.25, 5e17);
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color(0x000000);

    // Scene buffer at CSS resolution x sceneScale (integer sizes). The canvas
    // itself uses min(devicePixelRatio, 1.5) but only the cheap final pass runs
    // at that size. A remembered manual quality choice wins over the default.
    // Phones and GPUs on the logarithmic-depth fallback (no EXT_clip_control: about a third
    // of Android devices, Samsung Internet, Firefox) start lower; the watchdog adjusts.
    if (IS_TOUCH || !reversedDepth) this.quality = QUALITY_START_LOW;
    try {
      const saved = localStorage.getItem(QUALITY_KEY);
      if (saved !== null && QUALITY_LEVELS[+saved]) { this.quality = +saved; this.qualityManual = true; }
    } catch { /* storage unavailable */ }
    const q0 = QUALITY_LEVELS[this.quality];
    const bw = Math.max(1, Math.round(container.clientWidth * q0.sceneScale)), bh = Math.max(1, Math.round(container.clientHeight * q0.sceneScale));
    const rt = new THREE.WebGLRenderTarget(bw, bh, {
      type: THREE.HalfFloatType, samples: q0.msaa,
      // reversed depth only pays off with a float depth attachment (the key must be
      // absent, not undefined, on the logarithmic path: three rejects undefined)
      ...(reversedDepth ? { depthTexture: new THREE.DepthTexture(bw, bh, THREE.FloatType) } : {}),
    });
    this.composer = new EffectComposer(r, rt);
    this.composer.setPixelRatio(1);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(bw, bh), 0.55, 0.55, 0.9);
    // Black-screen fix: NaN/Inf or absurdly bright pixels (e.g. the Sun mirrored
    // in the canopy) must never reach the bloom blur, which would smear them
    // over the whole frame and tone-map to black.
    hardenBloomPass(this.bloom, 16);
    this.composer.addPass(this.bloom);
    const output = new OutputPass();
    hardenOutputPass(output);
    this.composer.addPass(output);
    this.outputPass = output;

    const pmrem = new THREE.PMREMGenerator(r);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.pmrem = pmrem;

    // sky (the Milky Way is baked once into a cubemap: static image, heavy shader)
    this.stars = makeStars();
    // painted textures are smaller on phones (GPU memory): 512 px a face instead of 1024
    const bakeSize = IS_TOUCH ? 512 : 1024;
    this.bakeSize = bakeSize;
    this.milky = makeMilkyWay(bakeMilkyWay(r, bakeSize));
    this.scene.add(this.stars, this.milky);

    // lights
    this.light = new THREE.DirectionalLight(0xffffff, 3);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(q0.shadowMap, q0.shadowMap);
    // bias sign is the same for both depth modes: patchShadowChunk() fixes three's PCF path
    this.light.shadow.bias = -0.0004;
    this.light.shadow.normalBias = 0.08;
    // three r186 flags the shadow camera as reversed-depth inside the shadow pass but
    // never rebuilds its projection, so a projection built before that first pass is a
    // normal one while the depth test is GEQUAL: the map keeps the FARTHEST surface and
    // shadows appear without casters (dark polygons, bands) while real ones go missing.
    // Set the flag ourselves so every updateProjectionMatrix() below builds the right one.
    (this.light.shadow.camera as unknown as { _reversedDepth: boolean })._reversedDepth = reversedDepth;
    this.light.shadow.camera.updateProjectionMatrix();
    this.scene.add(this.light, this.light.target);
    this.hemi = new THREE.HemisphereLight(0x88aaff, 0x332211, 0.0);
    this.scene.add(this.hemi);

    this.plasmaMat = makePlasmaMaterial();
    this.gasBaker = new GasBaker(this.bakeSize);
    this.createBodies();
    this.glints = makeGlints(this.bodies.length);
    this.scene.add(this.glints);
    this.applyQuality(q0);

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
    // Warp streaks: a bare motion hint. The main light-speed effect is the
    // Doppler tint of the (static) sky plus a global blue colour grade, see updateScene.
    const S = 40;
    this.streakData = new Float32Array(S * 6);
    for (let i = 0; i < S; i++) this.respawnStreak(i, true);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(S * 6), 3));
    this.streaks = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: new THREE.Color(0.45, 0.6, 0.95), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 1002;
    this.scene.add(this.streaks);

    // bright-light comfort mode: remember base colours of every glowing material
    const seen = new Set<THREE.Material>();
    const reg = (m: THREE.Material | THREE.Material[]) => {
      for (const x of Array.isArray(m) ? m : [m]) {
        if (seen.has(x) || !('color' in x)) continue;
        seen.add(x);
        const mc = x as THREE.Material & { color: THREE.Color };
        this.glowMats.push({ mat: mc, base: mc.color.clone() });
      }
    };
    for (const o of [...this.ship.flames, ...this.ship.glows, ...this.ship.navLights, ...this.astro.jet]) reg(o.material);
    try {
      const v = localStorage.getItem(LIGHTS_KEY);
      if (v === 'bright' || v === 'comfort') this.lightsMode = v;
      const fs = localStorage.getItem('helios-faststart');
      if (fs === '0' || fs === '1') this.fastStart = fs === '1';
    } catch { /* storage unavailable */ }
    this.applyLightsMode();

    this.spawnStart();
    this.ruins = new RuinedEarth(this, this.byId.get('earth')!);
    this.alien = new AlienWorld(this);
    // the chosen point: a cyan ring on the ground with its name and distance
    this.wpMarker = document.createElement('div');
    this.wpMarker.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;display:none;white-space:nowrap;font-family:ui-monospace,monospace;';
    const wd = document.createElement('div');
    wd.style.cssText = 'width:14px;height:14px;border:2px solid #67e8f9;border-radius:50%;transform:translate(-50%,-50%);position:absolute;left:0;top:0;box-sizing:border-box;';
    this.wpLabel = document.createElement('div');
    this.wpLabel.style.cssText = 'position:absolute;left:12px;top:-7px;font-size:11px;color:#a5f3fc;text-shadow:0 0 4px #000;letter-spacing:.05em;';
    this.wpArrow = document.createElement('div');
    this.wpArrow.style.cssText = 'position:absolute;left:0;top:0;display:none;color:#67e8f9;font-size:12px;line-height:1;text-shadow:0 0 4px #000;';
    this.wpArrow.textContent = '▲';
    this.wpMarker.append(wd, this.wpLabel, this.wpArrow);
    this.markerLayer.appendChild(this.wpMarker);
    this.bindInput();
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    r.domElement.addEventListener('webglcontextlost', this.onContextLost);
    r.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
    this.cw = Math.max(1, container.clientWidth); this.ch = Math.max(1, container.clientHeight);
    try {
      this.seen = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
      this.tour = new Set(JSON.parse(localStorage.getItem(TOUR_KEY) ?? '[]') as string[]);
    } catch { /* storage unavailable */ }
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  // -------------------------------------------------------------------------
  private createBodies() {
    for (const def of BODIES) {
      // Reference frames: a body's position is stored relative to its own star
      // (`local`, small exact numbers) and stars carry their absolute ecliptic
      // position (`starAbs`). `pos`, used by the rest of the game, is rebuilt by
      // refreshPositions() relative to the star that currently lights the scene,
      // so coordinates inside any system stay precise to millimetres even
      // light-years away from the Sun.
      const local = V();
      const starAbs = V();
      let star: Body | null = null;
      if (def.kind === 'star') {
        // angle = ecliptic longitude from +X towards -Z (right-handed sky, matches the star
        // catalogue), lat = ecliptic latitude (+Y = north), orbit = distance to the Sun
        const lat = def.lat ?? 0;
        starAbs.set(Math.cos(lat) * Math.cos(def.angle) * def.orbit, Math.sin(lat) * def.orbit, -Math.cos(lat) * Math.sin(def.angle) * def.orbit);
      } else if (def.parent) {
        const p = this.byId.get(def.parent)!;
        const inc = def.incl ?? 0;
        local.set(Math.cos(def.angle) * def.orbit, Math.sin(def.angle) * def.orbit * Math.sin(inc), Math.sin(def.angle) * def.orbit * Math.cos(inc)).add(p.local);
        star = p.star;
      } else {
        local.set(Math.cos(def.angle) * def.orbit, 0, Math.sin(def.angle) * def.orbit);
        star = this.byId.get('sun')!;
      }
      const root = new THREE.Group();
      this.scene.add(root);
      const tiltQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), def.tilt);
      const invRot = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(tiltQ.clone().invert()));
      const marker = document.createElement('div');
      marker.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;display:none;white-space:nowrap;font-family:ui-monospace,monospace;';
      const dot = document.createElement('div');
      // a hollow ring around the body (sized each frame): it must never cover the body itself
      dot.style.cssText = `width:14px;height:14px;border:1.5px solid ${def.markerColor};border-radius:50%;transform:translate(-50%,-50%);position:absolute;left:0;top:0;box-sizing:border-box;`;
      const label = document.createElement('div');
      label.style.cssText = `position:absolute;left:10px;top:-7px;font-size:11px;color:${def.markerColor};text-shadow:0 0 4px #000;letter-spacing:.05em;`;
      marker.append(dot, label);
      this.markerLayer.appendChild(marker);
      const b: Body = { def, pos: V(), local, star: null as unknown as Body, starAbs: star ? star.starAbs : starAbs, root, tiltQ, invRot, marker, label, collapsed: false, occluders: [], built: def.kind === 'star' };
      b.star = star ?? b;

      if (def.kind === 'star') {
        const st = def.star ?? SUN_STAR;
        b.starMat = makeSunMaterial(st);
        const m = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), b.starMat);
        m.scale.setScalar(def.radius);
        b.coronaMat = makeCoronaMaterial(st);
        const corona = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), b.coronaMat);
        corona.scale.setScalar(def.radius * 1.35); // = uShell
        b.coronaMat.uniforms.uR.value = def.radius;
        corona.renderOrder = 4;
        root.add(corona);
        const g = st.glowStops;
        const stop = (k: number, a: number) => `rgba(${g[k][0]},${g[k][1]},${g[k][2]},${a})`;
        const glowTex = radialTexture([[0, stop(0, 1)], [0.12, stop(1, 0.55)], [0.35, stop(2, 0.12)], [1, stop(3, 0)]]);
        const tint = new THREE.Color(...st.glowTint);
        b.glowBase = tint.clone().multiplyScalar(st.glowIntensity);
        b.glow2Base = tint.clone().multiplyScalar(st.glowIntensity * 0.16);
        b.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: b.glowBase.clone() }));
        b.glow2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: b.glow2Base.clone() }));
        b.glow.renderOrder = 5;
        b.glow2.renderOrder = 5;
        root.add(m, b.glow, b.glow2);
        this.starBodies.push(b);
        if (!this.sunBody) this.sunBody = b;
      }
      this.bodies.push(b);
      this.byId.set(def.id, b);
    }
    this.refreshPositions();
    this.nearest = this.byId.get('earth')!;
    // eclipse casters: a body's moons, its planet and sibling moons (orbits are static)
    for (const b of this.bodies) {
      if (b.def.kind === 'star') continue;
      const reach = (o: Body) => o.def.radius / o.local.distanceTo(b.local); // apparent size
      b.occluders = this.bodies
        .filter((o) => o !== b && o.def.kind !== 'star' && o.star === b.star && o.local.distanceTo(b.local) < 5e9)
        .sort((x, y) => reach(y) - reach(x))
        .slice(0, 4);
    }
    // The worlds of the system you start in are built now; the others while you travel
    // to them (prepareSystem / updateSystemPrep), so the load time stays the same however
    // many systems there are.
    this.prepareSystem(this.sunBody, true);
  }

  /**
   * Builds a world's meshes and materials (terrain, gas, rings, atmosphere, clouds). Worlds
   * of other systems are built when the player heads there; their first terrain chunks
   * then come from the worker threads (asyncTerrain) so the flight does not stutter.
   */
  private buildWorld(b: Body, asyncTerrain = true) {
    if (b.built) return;
    b.built = true;
    const def = b.def, root = b.root, tiltQ = b.tiltQ;
    if (def.kind === 'gas') {
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
      b.terrain = new PlanetTerrain(def.id, def.radius, gen, mat, b.waterMat ?? null, rockMat, treeMat, asyncTerrain);
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
      if (a.ozone) u.uBetaO.value.set(a.ozone[0] * R, a.ozone[1] * R, a.ozone[2] * R);
      u.uLut.value = makeOpticalDepthLut(1 + a.height / R, a.HR / R, a.HM / R);
      b.atmo = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), b.atmoMat);
      b.atmo.scale.setScalar(R + a.height);
      b.atmo.renderOrder = 4;
      root.add(b.atmo);
    }
    if (def.clouds) {
      // the pattern is painted once (Earth's fine weather needs 1024 px a face, Venus' and Titan's hazes 512)
      const csize = def.clouds.type === 0 ? this.bakeSize : 512;
      const crt = bakeClouds(this.renderer, def.clouds.type, csize);
      const cmap = crt.texture;
      b.cloudMat = makeCloudMaterial(def.clouds.type, cmap);
      // sunlight reaching the deck comes from the body's own atmosphere model
      const am = b.atmoMat?.uniforms;
      if (am) for (const k of ['uRa', 'uBetaR', 'uBetaM', 'uBetaO', 'uLut']) b.cloudMat.uniforms[k] = am[k];
      if (b.tUniforms && def.clouds.type === 0) {
        // Earth: the clouds cast their shadows on the ground
        b.terrain!.material.defines = { HELIOS_CLOUD_SHADOW: '' };
        b.tUniforms.uCloudMap.value = cmap;
        b.tUniforms.uCloudShellR.value = def.radius + def.clouds.alt;
        b.tUniforms.uCloudCov.value = def.clouds.coverage;
        b.tUniforms.uCloudOpac.value = def.clouds.opacity;
        // the same clouds on the CPU, for the shadow over the player, ship and astronaut
        b.cloudCPU = new CubeReadback(this.renderer, crt, csize);
      }
      b.cloudMat.uniforms.uColor.value.set(...def.clouds.color);
      b.cloudMat.uniforms.uCoverage.value = def.clouds.coverage;
      b.cloudMat.uniforms.uOpacity.value = def.clouds.opacity;
      b.clouds = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), b.cloudMat);
      b.clouds.scale.setScalar(def.radius + def.clouds.alt);
      b.clouds.renderOrder = 3;
      root.add(b.clouds);
    }
  }

  /** Queue the worlds of a star's system to be built; `now` builds them all at once. */
  private prepareSystem(star: Body, now = false) {
    if (!this.preparedStars.has(star)) {
      this.preparedStars.add(star);
      for (const b of this.bodies) if (b.star === star && !b.built && !this.buildQueue.includes(b)) this.buildQueue.push(b);
    }
    if (now) {
      for (const b of this.buildQueue) if (b.star === star) this.buildWorld(b, star !== this.byId.get('sun'));
      this.buildQueue = this.buildQueue.filter((q) => !q.built);
    }
  }

  /**
   * Starts preparing a system as soon as the player heads for it (one of its worlds is
   * the destination, or the ship is a good part of the way there, well before the frame
   * switches to its star) and builds the queued worlds a few milliseconds per frame.
   */
  private updateSystemPrep() {
    const cw = this.camWorld;
    const dHere = cw.distanceTo(this.sunBody.pos);
    for (const s of this.starBodies) {
      if (this.preparedStars.has(s)) continue;
      if (this.target?.star === s || cw.distanceTo(s.pos) < dHere * 1.5) this.prepareSystem(s);
    }
    const t0 = performance.now();
    while (this.buildQueue.length && performance.now() - t0 < 8) this.buildWorld(this.buildQueue.shift()!);
  }

  /** Sunlight let through by body b's cloud deck at world point p (Earth-type weather only). */
  private cloudShadowAt(b: Body, p: THREE.Vector3, sunDir: THREE.Vector3) {
    const cl = b.def.clouds;
    if (!cl || cl.type !== 0 || !b.clouds) return 1;
    const rel = p.clone().sub(b.pos);
    const r = rel.length(), Rc = b.def.radius + cl.alt;
    const mu = rel.dot(sunDir) / r;
    if (r >= Rc || mu <= 0) return 1;
    if (!b.cloudCPU) return 1;
    const q = rel.addScaledVector(sunDir, (Rc - r) / Math.max(mu, 0.05)).applyQuaternion(b.clouds.quaternion.clone().invert()).normalize();
    const c = (b.cloudCPU.sample(q.x, q.y, q.z) - 0.5) * CLOUD_DECODE;
    return 1 - 0.7 * smoothstep(cl.coverage, cl.coverage + 0.32, c) * cl.opacity;
  }

  /** Share of the star's disc visible from world point p, hidden by the occluders of body b. */
  private eclipseAt(b: Body, p: THREE.Vector3) {
    const toSun = this.sunBody.pos.clone().sub(p);
    const dS = toSun.length();
    toSun.divideScalar(dS);
    const rs = Math.asin(Math.min(1, this.sunBody.def.radius / dS));
    let vis = 1;
    for (const o of b.occluders) {
      const d = o.pos.clone().sub(p);
      const dist = d.length();
      if (d.dot(toSun) <= 0) continue;
      const ro = Math.asin(Math.min(1, o.def.radius / dist));
      const sep = Math.asin(Math.min(1, d.clone().cross(toSun).length() / dist));
      const cover = clamp((ro + rs - sep) / (2 * Math.min(ro, rs)), 0, 1);
      vis *= 1 - cover * cover * (3 - 2 * cover) * Math.min(1, (ro * ro) / (rs * rs));
    }
    return vis;
  }

  /**
   * Eclipse uniforms of one material: occluders relative to the body centre, divided by
   * `unit` (metres per material unit) and rotated by q into the material's space; origin
   * is the body centre in that space. enabled = false clears them (the scene light of the
   * player's own world already carries the eclipse).
   */
  private setEclipse(u: Record<string, THREE.IUniform>, body: Body, bSun: THREE.Vector3, unit: number, origin: THREE.Vector3, q: THREE.Quaternion | null, enabled = true) {
    (u.uEclOrigin.value as THREE.Vector3).copy(origin);
    const occ = u.uOcc.value as THREE.Vector4[];
    const v = _e1;
    for (let i = 0; i < 4; i++) {
      const o = enabled ? body.occluders[i] : undefined;
      if (!o) { occ[i].set(0, 0, 0, 0); continue; }
      v.copy(o.pos).sub(body.pos);
      if (q) v.applyQuaternion(q);
      occ[i].set(v.x / unit, v.y / unit, v.z / unit, o.def.radius / unit);
    }
    (u.uEclSun.value as THREE.Vector3).copy(bSun);
    if (q) (u.uEclSun.value as THREE.Vector3).applyQuaternion(q);
    u.uEclSunR.value = Math.asin(Math.min(1, this.sunBody.def.radius / this.sunBody.pos.distanceTo(body.pos)));
  }

  /** Express every body position in the current frame (relative to the star lighting the scene). */
  private refreshPositions() {
    const f = this.sunBody.starAbs;
    for (const b of this.bodies) b.pos.copy(b.star.starAbs).sub(f).add(b.local);
  }

  /** Move the reference frame to another star: shift every dynamic position by the interstellar offset. */
  private switchFrame(star: Body) {
    this.prepareSystem(star, true); // normally built long before, during the flight
    const delta = star.starAbs.clone().sub(this.sunBody.starAbs);
    for (const v of [this.shipPos, this.playerPos, this.camWorld, this.lastCamWorld]) v.sub(delta);
    this.sunBody = star;
    this.refreshPositions();
    this.note(`Entrando en el sistema de ${star.def.name}`);
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
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('pointerlockerror', this.onLockError);
    this.renderer.domElement.addEventListener('click', this.requestLock);
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: true });
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
  }
  /** left button (while the pointer is locked): the survival weapon fires (held: repeats) */
  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || !this.locked) return;
    if (!this.keys.has('Mouse0')) this.pressed.add('Mouse0');
    this.keys.add('Mouse0');
  };
  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.keys.delete('Mouse0');
  };
  /** camera / steering drag from the touch controls (pixels, like mouse movement) */
  touchLook(dx: number, dy: number) {
    this.mdx += dx;
    this.mdy += dy;
    if (Math.abs(dx) + Math.abs(dy) > 2) this.lastMouseMove = this.time;
  }
  requestLock = () => {
    this.sfx.init(); // a click: browsers allow sound from here on
    if (this.menuOpen || this.dead || this.touchMode) return;
    const el = this.renderer.domElement as HTMLCanvasElement & { requestPointerLock: () => Promise<void> | void };
    try {
      const p = el.requestPointerLock();
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => this.onLockError());
    } catch { /* ignore */ }
  };
  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.renderer.domElement;
    if (this.locked) this.lockFails = 0;
  };
  /** the browser refuses to capture the mouse (too soon after Esc is normal; a page that never allows it is not) */
  private lockFails = 0;
  private onLockError = () => {
    if (++this.lockFails < 3 || !this.autoPause) return;
    this.autoPause = false;
    this.note('Este navegador no deja capturar el ratón: el juego sigue sin pausa automática');
  };
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Tab') e.preventDefault();
    if (!this.keys.has(e.code)) this.pressed.add(e.code);
    this.keys.add(e.code);
    // a held key auto-repeats: toggling on every repeat made the map flash open and shut
    if ((e.code === 'KeyM' || e.code === 'Tab') && !e.repeat) this.toggleMenu();
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  /** Alt+Tab while holding a key never delivers its keyup: forget every held key. */
  private onBlur = () => {
    this.keys.clear();
  };
  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    this.mdx += e.movementX;
    this.mdy += e.movementY;
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) this.lastMouseMove = this.time;
  };
  private onWheel = (e: WheelEvent) => {
    const f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    if (this.vision && this.visionMode === 'eyes') this.zoomVision(e.deltaY > 0 ? 1.2 : 1 / 1.2);
    else if (this.mode === 'ship') this.camDistShip = clamp(this.camDistShip * f, 16, 120);
    else this.camDistFoot = clamp(this.camDistFoot * f, 2.2, 25);
  };

  /**
   * Vision mode (O): nothing drawn over the sky (no HUD, labels or markers), the view
   * from the astronaut's eyes or the cockpit, and a zoom down to 1° to look at the Moon,
   * the planets and the stars like through binoculars or a small telescope.
   */
  toggleVision(on = !this.vision) {
    this.vision = on;
    if (!on) this.visionMode = 'eyes';
    this.visionFov = VISION_FOV_MAX;
    this.onVisionToggle?.(on);
  }
  /** O: normal → vision (first person, zoom) → photo mode (third person, nothing on screen) → normal */
  cycleVision() {
    if (!this.vision) { this.visionMode = 'eyes'; this.toggleVision(true); }
    else if (this.visionMode === 'eyes') { this.visionMode = 'exterior'; this.visionFov = VISION_FOV_MAX; this.onVisionToggle?.(true); }
    else this.toggleVision(false);
  }
  /** camera distance (touch pinch; the wheel does the same) */
  zoomCam(f: number) {
    if (this.vision && this.visionMode === 'eyes') this.zoomVision(f);
    else if (this.mode === 'ship') this.camDistShip = clamp(this.camDistShip * f, 16, 120);
    else this.camDistFoot = clamp(this.camDistFoot * f, 2.2, 25);
  }
  /** P: the frame being drawn is saved as a picture (no flash, a quiet note) */
  takePhoto() { this.photoPending = true; }
  private savePhoto() {
    const name = `helios-${this.nearest.def.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')}.png`;
    try {
      this.renderer.domElement.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, 'image/png');
      this.note(`Foto guardada: ${name}`);
    } catch { this.note('No se pudo guardar la foto'); }
  }
  /** V (or the options): the pulse jump starts at high speed when far from every body */
  toggleFastStart() {
    this.fastStart = !this.fastStart;
    try { localStorage.setItem('helios-faststart', this.fastStart ? '1' : '0'); } catch { /* ignore */ }
    this.note(this.fastStart ? 'Arranque rápido del pulso: activado (lejos de los astros y con la ruta despejada)' : 'Arranque rápido del pulso: desactivado');
  }
  /** desktop: the pointer was freed (Esc) during play: the game waits in a calm pause */
  autoPause = true;
  isPaused() {
    const sv = this.surv;
    return this.autoPause && this.started && !this.touchMode && !this.locked && !this.dead && !this.menuOpen && !sv?.reading && !sv?.intro && !sv?.ending;
  }
  /** zoom factor < 1 zooms in */
  zoomVision(f: number) {
    if (this.vision) this.visionFov = clamp(this.visionFov * f, VISION_FOV_MIN, VISION_FOV_MAX);
  }
  private onResize = () => {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.cw = Math.max(1, w); this.ch = Math.max(1, h);
    this.renderer.setSize(w, h);
    const s = QUALITY_LEVELS[this.quality].sceneScale;
    this.composer.setSize(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  /** Apply a quality level: scene buffer scale, shadow map size, atmosphere ray-march steps. */
  private applyQuality(q: QualityLevel) {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    for (const t of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (t.samples !== q.msaa) { t.samples = q.msaa; t.dispose(); } // reallocated on next use
    }
    this.composer.setSize(Math.max(1, Math.round(w * q.sceneScale)), Math.max(1, Math.round(h * q.sceneScale)));
    const sh = this.light.shadow;
    if (sh.mapSize.x !== q.shadowMap) {
      sh.mapSize.set(q.shadowMap, q.shadowMap);
      if (sh.map) { sh.map.dispose(); sh.map = null; }
    }
    for (const b of this.bodies) {
      const m = b.atmoMat;
      if (!m) continue;
      if (m.defines.ATMO_NS !== q.atmoSteps) {
        m.defines.ATMO_NS = q.atmoSteps;
        m.needsUpdate = true;
      }
    }
    // shader recompiles and buffer reallocation cause hitches: ignore them for a while (wall clock, ms)
    this.qualityGrace = performance.now() + 6000;
    this.qualityWin.t0 = 0; this.qualityWin.frames = 0; this.qualityWin.bad = 0;
  }

  setQuality(level: number, manual: boolean) {
    level = clamp(level, 0, QUALITY_LEVELS.length - 1);
    this.quality = level;
    this.qualityManual = manual;
    this.applyQuality(QUALITY_LEVELS[level]);
    if (manual) { try { localStorage.setItem(QUALITY_KEY, String(level)); } catch { /* ignore */ } }
  }

  /** Steps the quality down one level when the frame rate stays under MIN_FPS for 4 s (auto mode only). */
  private qualityWatchdog(t: number) {
    if (this.qualityManual || this.quality >= QUALITY_LEVELS.length - 1 || t < this.qualityGrace) return;
    const w = this.qualityWin;
    if (w.t0 === 0) { w.t0 = t; w.frames = 0; return; }
    w.frames++;
    const span = t - w.t0;
    if (span < 1000) return;
    const fps = (w.frames * 1000) / span;
    w.bad = fps < Math.min(MIN_FPS, this.refreshHz * 0.9) ? w.bad + 1 : 0;
    w.frames = 0; w.t0 = t;
    if (w.bad >= 4) {
      this.setQuality(this.quality + 1, false);
      this.note(`Calidad gráfica reducida a ${QUALITY_LEVELS[this.quality].name} para mantener la fluidez (${this.touchMode ? 'cámbiala en OPCIONES' : 'G para cambiar'})`);
    }
  }

  private applyLightsMode() {
    const comfort = this.lightsMode === 'comfort';
    this.bloom.strength = comfort ? 0.25 : 0.55;
    this.bloom.threshold = comfort ? 1.2 : 0.9;
    (this.bloom.highPassUniforms as Record<string, THREE.IUniform>).heliosMax.value = comfort ? 6 : 16;
    this.baseExposure = comfort ? 0.82 : 1.0;
    for (const st of this.starBodies) {
      const sd = st.def.star ?? SUN_STAR;
      st.starMat!.uniforms.uI.value = sd.intensity * (comfort ? 0.45 : 1);
      st.coronaMat!.uniforms.uI.value = sd.coronaIntensity * (comfort ? 0.45 : 1);
    }
    const f = comfort ? 0.45 : 1;
    this.glowFactor = f;
    for (const { mat, base } of this.glowMats) mat.color.copy(base).multiplyScalar(f);
  }

  setLightsMode(mode: LightsMode) {
    this.lightsMode = mode;
    this.applyLightsMode();
    try { localStorage.setItem(LIGHTS_KEY, mode); } catch { /* ignore */ }
    this.onLightsModeChange?.(mode);
  }

  toggleMenu(force?: boolean) {
    if (!this.started) return; // the title screen keeps the game paused
    const open = force ?? !this.menuOpen;
    if (open && this.dead) return; // the death screen stays until the pilot wakes up
    this.menuOpen = open;
    if (open) {
      // a finger or key held when the map opened would never be released
      this.keys.clear();
      if (document.pointerLockElement) document.exitPointerLock();
    }
    this.onMenuToggle?.(this.menuOpen);
  }

  /** a key or button as this device calls it ("E" on a keyboard, "NAVE" on a phone) */
  keyLabel(code: string) {
    if (!this.touchMode) return KEY_DESK[code] ?? code;
    if (code === 'KeyE') return this.mode === 'foot' ? 'NAVE' : this.landed ? 'BAJAR' : 'ATERRIZAR';
    return KEY_TOUCH[code] ?? code;
  }
  /** replaces {KeyE}-style marks with the names of this device's keys or buttons */
  fmt(text: string) {
    return text.replace(/\{(Key[A-Z]|Space|Mouse0|Digit\d|WeaponToggle)\}/g, (_, c: string) => this.keyLabel(c));
  }

  /** the places the map lists: mission points known so far (survival), or every ruin and alien place */
  places(): Place[] {
    if (this.surv) return this.surv.missionPlaces();
    return [...LANDMARKS.map((l) => l.id), ...this.alien.sites.map((s) => s.id), ...this.ruins.sites.map((s) => s.id)]
      .map((id) => this.placeOf(id)).filter((p): p is Place => !!p);
  }
  placeOf(id: string): Place | null {
    // exploration describes what a place is; survival tells its part of the story
    const info = (k: string) => (this.surv ? PLACE_INFO[k] : PLACE_INFO_EXPLORE[k] ?? PLACE_INFO[k]) ?? '';
    const lm = LANDMARKS.find((l) => l.id === id);
    if (lm) {
      const b = this.byId.get(lm.body)!;
      return { id, name: lm.name, body: lm.body, world: b.def.name, system: b.star.def.name, desc: info(id), real: true };
    }
    if (id === 'sunset') {
      const s = this.sunsetWp;
      return s ? { id, name: 'Atardecer', body: s.body.def.id, world: s.body.def.name, system: s.body.star.def.name, desc: 'El sol a 3° sobre el horizonte: luz dorada y sombras largas.' } : null;
    }
    if (id === 'event') return this.surv?.events.place() ?? null;
    if (id.startsWith('cache-')) return this.surv?.cachePlace(id) ?? null;
    const al = this.alien.site(id);
    if (al) {
      const b = this.byId.get(al.body)!;
      return { id, name: al.name, body: al.body, world: b.def.name, system: b.star.def.name, desc: info(id) };
    }
    const ru = this.ruins.site(id);
    if (!ru) return null;
    return { id, name: ru.name, body: 'earth', world: 'Tierra', system: 'Sol', desc: info(id) || (ru.kind === 'station' ? 'Estación en ruinas.' : 'Ciudad en ruinas. Nadie responde.') };
  }
  /** Go to a place: its world becomes the destination (jump, autopilot) and the point is marked on the ground. */
  setWaypoint(id: string | null, user = true) {
    const p = id ? this.placeOf(id) : null;
    if (!id || !p) { this.waypoint = null; this.waypointUser = false; return; }
    this.waypoint = { id: p.id, name: p.name };
    this.waypointUser = user;
    this.target = this.byId.get(p.body) ?? null;
    if (!user) return;
    const here = this.target === this.nearest && this.target?.def.kind === 'rocky';
    if (id.startsWith('cache-')) this.note(`Destino: ${p.world}. El escáner no da el punto exacto: al llegar, sigue su aguja`);
    else if (here) this.note(`Destino: ${p.name}. {KeyK}: vuelo suborbital hasta allí; sigue el círculo ○`);
    else this.note(`Destino: ${p.name} (${p.world}). {KeyJ}: salto · {KeyK}: piloto automático; al llegar, {KeyK} otra vez te lleva hasta el punto ○`);
  }
  /** the sunset (or sunrise) nearest to the player on this world: the Sun ~3° over the horizon */
  goToSunset() {
    const b = this.nearest;
    if (b.def.kind !== 'rocky') { this.note('Busca un mundo con suelo para ver un atardecer'); return false; }
    const p = (this.mode === 'ship' ? this.shipPos : this.playerPos).clone().sub(b.pos).normalize();
    const s = this.sunBody.pos.clone().sub(b.pos).normalize();
    const perp = p.clone().addScaledVector(s, -p.dot(s));
    if (perp.lengthSq() < 1e-8) perp.set(-s.y, s.x, 0).add(new THREE.Vector3(0, -s.z, s.y));
    perp.normalize();
    const el = (3 * Math.PI) / 180;
    this.sunsetWp = { body: b, dir: perp.multiplyScalar(Math.cos(el)).addScaledVector(s, Math.sin(el)).normalize() };
    return true;
  }
  /** a place's world and direction from its centre (null: no exact point, like a cache the scanner only hears) */
  placePoint(id: string): { b: Body; dir: THREE.Vector3 } | null {
    if (id === 'sunset') return this.sunsetWp ? { b: this.sunsetWp.body, dir: this.sunsetWp.dir } : null;
    if (id === 'event') { const a = this.surv?.events.active; return a ? { b: a.body, dir: a.dir } : null; }
    const lm = LANDMARKS.find((l) => l.id === id);
    if (lm) return { b: this.byId.get(lm.body)!, dir: new THREE.Vector3(...lm.dir).normalize() };
    const al = this.alien.site(id);
    if (al) return { b: this.alien.body(al), dir: al.dir };
    const ru = this.ruins.site(id);
    if (ru) return { b: this.byId.get('earth')!, dir: ru.logPos.clone().normalize() };
    return null;
  }
  private waypointPos(out: THREE.Vector3): { pos: THREE.Vector3; far: string | null } | null {
    const id = this.waypoint?.id;
    const pt = id ? this.placePoint(id) : null;
    if (!pt) return null;
    if (pt.b.star !== this.sunBody) return { pos: out.copy(pt.b.star.pos), far: pt.b.star.def.name };
    return { pos: out.copy(pt.b.pos).addScaledVector(pt.dir, pt.b.def.radius + (pt.b.terrain ? this.surfaceH(pt.b, pt.dir) : 0)), far: null };
  }
  /**
   * Places a marker for a point (relative to the camera): where it is on screen, or, when it is
   * off screen or behind, held at the edge with an arrow towards it. Returns where it ended up.
   */
  pinMarker(el: HTMLElement, arrow: HTMLElement | null, rel: THREE.Vector3, pin = true): 'in' | 'edge' | 'none' {
    const fwd = _v4.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const behind = rel.dot(fwd) <= 0;
    const v = _v3.copy(rel).project(this.camera);
    let x = v.x, y = v.y;
    const inside = !behind && Math.abs(x) <= 1 && Math.abs(y) <= 1;
    if (!inside) {
      if (!pin) { css(el, 'display', 'none'); return 'none'; }
      if (behind) { x = -x; y = -y; }
      const m = Math.max(Math.abs(x), Math.abs(y), 1e-6) / 0.9;
      x /= m; y /= m;
    }
    css(el, 'display', 'block');
    css(el, 'transform', `translate(${((x * 0.5 + 0.5) * this.cw).toFixed(0)}px, ${((-y * 0.5 + 0.5) * this.ch).toFixed(0)}px)`);
    if (arrow) {
      css(arrow, 'display', inside ? 'none' : 'block');
      if (!inside) css(arrow, 'transform', `translate(-50%, -50%) rotate(${((Math.atan2(x, y) * 180) / Math.PI).toFixed(0)}deg) translateY(-17px)`);
    }
    return inside ? 'in' : 'edge';
  }
  private updateWaypoint() {
    const m = this.wpMarker;
    this.wpDist = null;
    const wp = this.waypointPos(_v1);
    if (!wp) { css(m, 'display', 'none'); return; }
    const focus = this.mode === 'ship' ? this.shipPos : this.playerPos;
    const dist = wp.pos.distanceTo(focus);
    if (!wp.far) this.wpDist = dist;
    if (!wp.far && dist < 25 && this.mode === 'foot') {
      this.note(`Has llegado: ${this.waypoint!.name}`);
      this.waypoint = null;
      this.waypointUser = false;
      css(m, 'display', 'none');
      return;
    }
    // nothing over the sky in vision mode; the objective's own marker already shows it
    if (this.vision || (this.surv && this.surv.objective().place === this.waypoint!.id)) { css(m, 'display', 'none'); return; }
    const rel = _v2.copy(wp.pos).sub(this.camWorld);
    this.pinMarker(m, this.wpArrow, rel);
    if (this.frame % 6 === 0) this.wpLabel.textContent = `${wp.far ? `→ ${wp.far.toUpperCase()}` : this.waypoint!.name.toUpperCase()}  ${formatDist(wp.far ? rel.length() : dist)}`;
  }

  setTarget(id: string | null) {
    this.target = id ? this.byId.get(id) ?? null : null;
    if (this.target) this.note(`Destino fijado: ${this.target.def.name}. {KeyJ}: salto libre · {KeyK}: piloto automático hacia el destino`);
  }

  note(text: string) {
    text = this.fmt(text);
    this.notes.push({ id: ++this.noteId, text, t: this.simTime });
    if (this.notes.length > 5) this.notes.shift();
    this.log(text, false);
  }
  /** the map's journal: the last 50 notes and VEGA lines, with the time they came */
  log(text: string, vega: boolean) {
    this.journal.push({ t: this.surv ? this.surv.playTime : this.simTime, text, vega });
    if (this.journal.length > 50) this.journal.shift();
  }

  respawn() {
    const b = this.nearest;
    const R = b.def.radius;
    let off = b.def.kind === 'star' ? R * 6 : Math.max(R * 0.35, (b.def.atmo?.height ?? 0) * 2.5, 60000);
    // survival: the void rays live below HUNTER_ALT over their worlds; the ship is rebuilt above them
    if (this.surv && (b.def.id === 'proxima-b' || b.def.id === 'trappist-1e') && !this.surv.enemies.guardianDown) off = Math.max(off, HUNTER_ALT * 1.3);
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
    this.hop = null;
    this.hurt = 0;
    this.pressureNotes.clear();
    if (this.surv) this.surv.onRevive(true);
    else this.note('Nave reconstruida en órbita');
  }

  die(reason: string) {
    if (this.dead) return;
    this.dead = reason;
    this.surv?.onDeath(this.mode === 'foot');
    this.warp = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private respawnPlayerInShip() {
    this.mode = 'ship';
    this.suit = 100;
    this.dead = null;
    this.hurt = 0;
    this.swimming = false;
    if (this.surv) this.surv.onRevive(false);
    else this.note('Has despertado a bordo de la nave');
  }

  revive() {
    if (!this.dead) return;
    if (this.mode === 'foot') this.respawnPlayerInShip();
    else this.respawn();
  }

  /** Survival mode: a new game (the old save is replaced) or the saved one. */
  startSurvival(continueSave: boolean) {
    this.gameMode = 'survival';
    this.surv = new Survival(this, this.markerLayer);
    this.sfx.init(); // called from the start button: the sound may start
    const s = continueSave ? Survival.load() : null;
    if (s && this.restoreSurvival(s)) return true;
    Survival.clear();
    // a new game: the ship's computer wakes the pilot over the silent Earth
    this.surv.intro = true;
    this.target = this.byId.get('earth')!;
    this.surv.save(); // "Continuar" exists from the first second
    return false;
  }

  private restoreSurvival(s: SurvivalSave) {
    const okPos = Array.isArray(s.off) && s.off.every((v) => typeof v === 'number' && Number.isFinite(v)) && Array.isArray(s.q) && s.q.every((v) => typeof v === 'number' && Number.isFinite(v));
    const b = this.byId.get(s.body);
    if (!b || !okPos) {
      // a damaged position: keep everything else and wake up in orbit of the Earth
      this.surv!.apply(s);
      this.hull = Math.max(25, s.hull); this.suit = Math.max(25, s.health);
      this.mode = 'ship'; this.landed = false;
      this.spawnStart();
      return true;
    }
    if (b.star !== this.sunBody) this.switchFrame(b.star);
    this.prepareSystem(b.star, true);
    this.surv!.apply(s);
    const off = new THREE.Vector3(...s.off);
    // never wake up inside a danger: next to a star, or down in a gas giant's clouds
    const R = b.def.radius;
    if (b.def.kind === 'star' && off.length() < R * 6) off.setLength(R * 6);
    if (b.def.kind === 'gas' && off.length() < R + 50e3) off.setLength(R + Math.max(R * 0.35, (b.def.atmo?.height ?? 0) * 2.5));
    this.shipPos.copy(b.pos).add(off);
    this.shipQ.fromArray(s.q).normalize();
    this.camQ.copy(this.shipQ);
    this.shipVel.set(0, 0, 0);
    this.throttle = 0;
    this.landed = s.landed && b.def.kind === 'rocky';
    this.mode = 'ship';
    this.hull = Math.max(25, s.hull);
    this.suit = Math.max(25, s.health);
    this.target = s.target ? this.byId.get(s.target) ?? null : null;
    this.nearest = b;
    this.lastCamWorld.copy(this.shipPos);
    this.camWorld.copy(this.shipPos);
    return true;
  }

  /** Exploration: a new trip, or the saved one (where the ship was, its destination). */
  startExplore(continueSave: boolean) {
    this.gameMode = 'explore';
    this.sfx.init();
    const s = continueSave ? Game.loadExplore() : null;
    return !!s && this.restoreExplore(s);
  }
  static loadExplore(): ExploreSave | null {
    try {
      const raw = localStorage.getItem(EXPLORE_KEY);
      const s = raw ? (JSON.parse(raw) as ExploreSave) : null;
      return s && s.v === 1 ? s : null;
    } catch { return null; }
  }
  /** exploration remembers the trip (on boarding, every minute, when the page closes) */
  saveExplore() {
    if (!this.started || this.gameMode !== 'explore' || this.dead) return;
    if (![this.shipPos.x, this.shipPos.y, this.shipPos.z, this.shipQ.x, this.shipQ.w].every(Number.isFinite)) return;
    const { body } = this.findNearest(this.shipPos);
    const off = this.shipPos.clone().sub(body.pos);
    const s: ExploreSave = {
      v: 1, saved: Date.now(), body: body.def.id, off: [off.x, off.y, off.z], q: this.shipQ.toArray() as [number, number, number, number],
      landed: this.landed || this.mode === 'foot', target: this.target?.def.id ?? null, waypoint: this.waypoint?.id ?? null, time: this.simTime,
    };
    try { localStorage.setItem(EXPLORE_KEY, JSON.stringify(s)); } catch { /* storage full or unavailable */ }
  }
  private restoreExplore(s: ExploreSave) {
    const b = this.byId.get(s.body);
    const ok = !!b && Array.isArray(s.off) && s.off.every(Number.isFinite) && Array.isArray(s.q) && s.q.every(Number.isFinite);
    if (!b || !ok) return false;
    if (b.star !== this.sunBody) this.switchFrame(b.star);
    this.prepareSystem(b.star, true);
    const off = new THREE.Vector3(...s.off), R = b.def.radius;
    if (b.def.kind === 'star' && off.length() < R * 6) off.setLength(R * 6);
    if (b.def.kind === 'gas' && off.length() < R + 50e3) off.setLength(R + Math.max(R * 0.35, (b.def.atmo?.height ?? 0) * 2.5));
    this.shipPos.copy(b.pos).add(off);
    this.shipQ.fromArray(s.q).normalize();
    this.camQ.copy(this.shipQ);
    this.shipVel.set(0, 0, 0);
    this.landed = s.landed && b.def.kind === 'rocky';
    this.mode = 'ship';
    this.nearest = b;
    this.target = s.target ? this.byId.get(s.target) ?? null : null;
    this.simTime = s.time ?? 0;
    if (s.waypoint && s.waypoint !== 'sunset' && s.waypoint !== 'event') this.setWaypoint(s.waypoint, false);
    this.lastCamWorld.copy(this.shipPos);
    this.camWorld.copy(this.shipPos);
    return true;
  }

  /** the tab hidden: the sound stops and the game is saved; back: it goes on (the time away is not a slow frame) */
  private onVisibility = () => {
    if (document.hidden) {
      this.sfx.suspend();
      this.surv?.save();
      this.saveExplore();
    } else {
      this.sfx.resume();
      this.lastT = performance.now();
      this.qualityWin.t0 = 0;
    }
  };
  private onPageHide = () => this.saveExplore();
  private onContextLost = (e: Event) => { e.preventDefault(); };
  /** the GPU came back (a driver reset, a phone short of memory): what was painted once is painted again */
  private onContextRestored = () => {
    const r = this.renderer;
    (this.milky.material as THREE.ShaderMaterial).uniforms.uMap.value = bakeMilkyWay(r, this.bakeSize);
    for (const b of this.bodies) {
      const cl = b.def.clouds;
      if (!cl || !b.cloudMat) continue;
      const crt = bakeClouds(r, cl.type, cl.type === 0 ? this.bakeSize : 512);
      b.cloudMat.uniforms.uCloudMap.value = crt.texture;
      if (b.tUniforms && cl.type === 0) b.tUniforms.uCloudMap.value = crt.texture;
    }
    const prev = this.gasBaker.target as Body | null;
    if (prev?.gasMat) prev.gasMat.uniforms.uBaked.value = 0;
    this.gasBaker.target = null;
    this.gasBaker.ready = false;
    // the hull's and the suit's reflections were a picture on the GPU too
    const env = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    for (const e of [...this.ship.envMats, ...this.astro.envMats]) { e.mat.envMap = env; e.mat.needsUpdate = true; }
    r.shadowMap.needsUpdate = true;
    this.qualityGrace = performance.now() + 6000;
    this.note('Gráficos restaurados');
  };

  // -------------------------------------------------------------------------
  terrainH(b: Body, dir: THREE.Vector3) {
    return b.terrain ? b.terrain.heightAt(dir.x, dir.y, dir.z) : 0;
  }
  /** a world's sea level (null: no sea) */
  seaLevel(b: Body) { return b.terrain?.gen.seaLevel ?? null; }
  /** what holds you up: the ground, or the surface of the water over it */
  surfaceH(b: Body, dir: THREE.Vector3) {
    const h = this.terrainH(b, dir), sea = this.seaLevel(b);
    return sea !== null && h < sea ? sea : h;
  }
  /** a point inside a building or a structure (the ruins of Earth, the places of the signal) */
  solidAt(p: THREE.Vector3) {
    return (this.nearest.def.id === 'earth' && this.ruins.solidAt(p)) || this.alien.solidAt(p);
  }
  /** where the astronaut's shots leave from: the muzzle of the weapon raised in the right hand */
  muzzle(out: THREE.Vector3) {
    const up = _v1.copy(this.playerPos).sub(this.nearest.pos).normalize();
    const f = _v2.set(0, 0, -1).applyQuaternion(this.camera.quaternion).projectOnPlane(up).normalize();
    const right = _v3.crossVectors(f, up).normalize();
    return out.copy(this.playerPos).addScaledVector(up, 1.45).addScaledVector(right, 0.33).addScaledVector(f, 0.95);
  }

  private nearestStar(p: THREE.Vector3) {
    let best = this.starBodies[0], bd = Infinity;
    for (const s of this.starBodies) {
      const d = p.distanceToSquared(s.pos);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /**
   * RGB transmittance of body `b`'s atmosphere along the view ray from the camera
   * towards `dir` (1 = clear). Rayleigh scattering removes blue first, so a star
   * seen through an atmosphere turns yellow, then orange and red near the horizon.
   */
  private atmoTransmittance(b: Body, dir: THREE.Vector3, out: THREE.Vector3) {
    out.set(1, 1, 1);
    const a = b.def.atmo;
    if (!a || b.def.kind !== 'rocky') return out;
    const R = b.def.radius, Ra = R + a.height;
    const ro = _a1.copy(this.camWorld).sub(b.pos);
    const r2 = ro.lengthSq();
    if (r2 > Ra * Ra) return out;
    const bq = ro.dot(dir);
    const t1 = -bq + Math.sqrt(Math.max(bq * bq - (r2 - Ra * Ra), 0));
    const NS = 16, ds = t1 / NS;
    let odR = 0, odM = 0;
    const p = _a2;
    for (let i = 0; i < NS; i++) {
      p.copy(ro).addScaledVector(dir, ds * (i + 0.5));
      const h = Math.max(p.length() - R, 0);
      odR += Math.exp(-h / a.HR) * ds;
      odM += Math.exp(-h / a.HM) * ds;
    }
    const m = a.betaM * 1.1 * odM;
    const oz = a.ozone ?? [0, 0, 0];
    return out.set(
      Math.exp(-((a.betaR[0] + oz[0]) * odR + m)),
      Math.exp(-((a.betaR[1] + oz[1]) * odR + m)),
      Math.exp(-((a.betaR[2] + oz[2]) * odR + m)),
    );
  }

  /**
   * Sky radiance seen from `ro` (relative to the centre of body `b`, metres) along `dir`:
   * the same single-scattering model and units as the atmosphere shader, so the haze
   * painted with it matches the sky behind it. A small CPU march, a few rays per frame.
   */
  private skyRadiance(b: Body, ro: THREE.Vector3, dir: THREE.Vector3, sunDir: THREE.Vector3, sun: number, out: THREE.Vector3) {
    out.set(0, 0, 0);
    const a = b.def.atmo;
    if (!a) return out;
    const R = b.def.radius, Ra = R + a.height;
    const bq = ro.dot(dir), r2 = ro.lengthSq();
    const disc = bq * bq - (r2 - Ra * Ra);
    if (disc <= 0) return out;
    const t0 = Math.max(-bq - Math.sqrt(disc), 0);
    let t1 = -bq + Math.sqrt(disc);
    const dg = bq * bq - (r2 - R * R);
    if (dg > 0 && -bq - Math.sqrt(dg) > 0) t1 = Math.min(t1, -bq - Math.sqrt(dg));
    if (t1 <= t0) return out;
    const oz = a.ozone ?? [0, 0, 0];
    const mu = dir.dot(sunDir), g = a.g;
    const phR = (3 / (16 * Math.PI)) * (1 + mu * mu);
    const phM = ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu))) / ((2 + g * g) * Math.pow(Math.max(1 + g * g - 2 * g * mu, 1e-4), 1.5));
    // energy-conserving integration (each segment's in-scatter integrated exactly for
    // its density): long horizon paths get no colour bias from coarse steps
    const NS = 16, NL = 6, ds = (t1 - t0) / NS;
    const L = [0, 0, 0], Tv = [1, 1, 1];
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    for (let i = 0; i < NS; i++) {
      p.copy(ro).addScaledVector(dir, t0 + ds * (i + 0.5));
      const r = p.length(), h = Math.max(r - R, 0);
      const rR = Math.exp(-h / a.HR), rM = Math.exp(-h / a.HM);
      // sunlight reaching this point, hidden by the planet over the Sun's own diameter
      const muS = p.dot(sunDir) / r;
      const muHor = -Math.sqrt(Math.max(0, 1 - (R * R) / (r * r)));
      const vis = smoothstep(muHor - 0.0047, muHor + 0.0047, muS);
      let lR = 0, lM = 0;
      if (vis > 0) {
        const bS = r * muS;
        const dsl = (-bS + Math.sqrt(Math.max(0, bS * bS - (r * r - Ra * Ra)))) / NL;
        for (let k = 0; k < NL; k++) {
          q.copy(p).addScaledVector(sunDir, dsl * (k + 0.5));
          const hq = Math.max(q.length() - R, 0);
          lR += Math.exp(-hq / a.HR) * dsl;
          lM += Math.exp(-hq / a.HM) * dsl;
        }
      }
      for (let c = 0; c < 3; c++) {
        const ext = (a.betaR[c] + oz[c]) * rR + a.betaM * 1.1 * rM;
        const attS = vis > 0 ? Math.exp(-((a.betaR[c] + oz[c]) * lR + a.betaM * 1.1 * lM)) * vis : 0;
        const S = (a.betaR[c] * rR * phR + a.betaM * rM * phM * a.mieTint[c]) * attS;
        const segT = Math.exp(-ext * ds);
        L[c] += S * Tv[c] * (ext * ds < 1e-4 ? ds : (1 - segT) / ext);
        Tv[c] *= segT;
      }
    }
    return out.set(sun * L[0], sun * L[1], sun * L[2]);
  }

  /** Distance from the current star expressed in "Sun-equivalent AU": the distance from the Sun that would give the same irradiance. */
  private starAU(d: number) {
    return d / (AU * Math.sqrt((this.sunBody.def.star ?? SUN_STAR).luminosity));
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
    if (b.def.kind === 'star') return R * 2.5;
    if (b.def.kind === 'gas') return Math.max(R * 0.8, (b.def.atmo?.height ?? 0) * 4);
    return Math.max(R * 0.9, (b.def.atmo?.height ?? 0) * 4, 4000);
  }

  /** Why a full-power jump start is not allowed right now (null = allowed). */
  private fastStartBlocker(fwd: THREE.Vector3): string | null {
    const cosCone = Math.cos((12 * Math.PI) / 180);
    for (const b of this.bodies) {
      const rel = b.pos.clone().sub(this.shipPos);
      const len = rel.length();
      const dist = len - b.def.radius;
      if (dist < Math.max(b.def.radius * 20, 1e8)) return `demasiado cerca de ${b.def.name}`;
      if (rel.dot(fwd) / len > cosCone && dist < Math.max(this.dropAlt(b) * 50, b.def.radius * 2000)) return `${b.def.name} en la trayectoria`;
    }
    return null;
  }

  /** where the autopilot steers a jump: the body, or above the point chosen on it (to arrive on its side) */
  private warpAim(tgt: Body) {
    const pt = this.waypoint ? this.placePoint(this.waypoint.id) : null;
    const out = tgt.pos.clone();
    if (!pt || pt.b !== tgt) return out;
    const d = this.shipPos.distanceTo(tgt.pos);
    return out.addScaledVector(pt.dir, tgt.def.radius + Math.max(this.dropAlt(tgt) * 0.6, d * 0.35));
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
    const ground = def.kind === 'rocky' ? this.surfaceH(b, up) : 0;
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

    // fast-start toggle for the pulse engine
    if (this.pressed.has('KeyV')) this.toggleFastStart();

    // K: with a point chosen on this world, a suborbital flight there; otherwise the autopilot
    // (only with it on does the pulse jump steer towards the destination)
    if (this.pressed.has('KeyK')) {
      if (this.hop) { this.hop = null; this.shipVel.set(0, 0, 0); this.throttle = 0; this.note('Vuelo suborbital cancelado'); }
      else if (this.warp || !this.startHop()) {
        this.autopilot = !this.autopilot;
        if (!this.autopilot) this.note(`Piloto automático desactivado: salto libre, dirige ${this.touchMode ? 'arrastrando' : 'con el ratón'}`);
        else if (this.target) this.note(`Piloto automático: rumbo a ${this.target.def.name} durante el salto`);
        else this.note('Piloto automático activado: fija un destino con {KeyT} o en el mapa');
      }
    }
    if (this.hop) {
      if (this.pressed.has('KeyJ')) this.note('Primero termina el vuelo suborbital ({KeyK}: cancelar)');
      this.updateHop(dt);
      return;
    }

    // warp toggling
    if (this.pressed.has('KeyJ')) {
      if (this.warp) {
        this.warp = false;
        this.surv?.warpEnded();
        this.shipVel.copy(fwd).multiplyScalar(Math.min(this.warpSpeed, 2e5));
        this.sfx.play('whoosh', undefined, 0);
        this.note('Motor de pulso desactivado');
      } else if (this.landed) {
        this.note('Despega antes de activar el motor de pulso');
      } else if (def.atmo && alt < def.atmo.height * 0.7) {
        this.note('Sal de la atmósfera para activar el motor de pulso');
      } else if (alt < 15000 && def.kind !== 'star') {
        this.note('Demasiado cerca de la superficie para el salto');
      } else if (this.surv?.jumpStart() !== 'no') {
        this.warp = true;
        this.warpT = 0;
        this.sfx.play('whoosh', undefined, 1);
        this.warpSpeed = Math.max(this.shipVel.length(), 8000);
        let how = '';
        if (this.fastStart) {
          const block = this.fastStartBlocker(fwd);
          if (block) how = ` · arranque normal: ${block}`;
          else {
            this.warpSpeed = Math.max(this.warpSpeed, this.warpCap(this.shipPos) * 0.3);
            how = ` · arranque rápido a ${formatSpeed(this.warpSpeed)}`;
          }
        }
        if (!this.surv?.emergency) this.note((this.autopilot && this.target ? `Salto hacia ${this.target.def.name} (piloto automático)` : `Salto libre: dirige la nave ${this.touchMode ? 'arrastrando' : 'con el ratón'}`) + how);
      }
    }

    if (this.warp) {
      this.warpT += dt;
      this.surv?.warpBurn(dt, this.warpSpeed);
      // Free flight by default: the ship goes wherever you point it, whatever the
      // selected destination. Only with the autopilot on (K) does it steer there.
      const tgt = this.autopilot ? this.target : null;
      if (tgt && this.time - this.lastMouseMove > 0.6) {
        const want = this.warpAim(tgt).sub(this.shipPos).normalize();
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
      // drop out of warp
      const nn = this.findNearest(this.shipPos);
      const toB = nn.body.pos.clone().sub(this.shipPos);
      const along = toB.dot(f2);
      let stop: string | null = null;
      if (this.warpT > 1.2 && along > 0) {
        const da = this.dropAlt(nn.body);
        if (tgt) {
          const isTarget = nn.body === tgt;
          if (nn.alt < da * (isTarget ? 1 : 0.3)) stop = isTarget ? `Llegada: ${nn.body.def.name}` : `Trayectoria obstruida por ${nn.body.def.name}. Rodéalo y vuelve a saltar`;
        } else {
          // free flight: stop only when the current heading really leads into the body,
          // so passing near a planet does not kill the jump
          const miss = Math.sqrt(Math.max(0, toB.lengthSq() - along * along));
          if (nn.alt < da && miss < nn.body.def.radius + da * 0.6) stop = `Llegada: ${nn.body.def.name}`;
        }
      }
      if (!stop && nn.alt < 15000 && nn.body.def.kind !== 'star') stop = `Demasiado cerca de ${nn.body.def.name}: motor de pulso desactivado`;
      if (stop) {
        this.warp = false;
        this.surv?.warpEnded();
        this.shipVel.copy(f2).multiplyScalar(Math.min(this.warpSpeed, Math.max(nn.alt, 1000) * 0.3));
        this.throttle = 0.6;
        this.sfx.play('whoosh', undefined, 0);
        this.note(stop);
        if (stop.startsWith('Llegada')) this.arrived(nn.body);
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
    if (def.kind === 'star') maxS = clamp(altEff * 0.5, 1e5, 1e8); // fast enough to dive at the Sun
    if (boost) maxS = Math.min(maxS * 3.5, Math.max(1e7, maxS));
    const vert = (k.has('Space') ? 1 : 0) - (k.has('KeyC') || k.has('KeyQ') ? 1 : 0);
    // survival: the engines burn fuel, and an empty tank leaves only the weak reserve thrusters
    if (this.surv && !this.landed && !this.autoLand) maxS *= this.surv.thrustBurn(dt, this.throttle, boost, vert);

    if (!this.landed) this.onRoof = false;
    this.landGround = this.landed && def.kind === 'rocky' && !this.onRoof ? this.groundUnderGear(b) : null;
    if (this.landed) {
      this.shipVel.set(0, 0, 0);
      // exploration repairs itself on the ground; in survival only metal repairs the hull
      if (!this.surv) this.hull = Math.min(100, this.hull + dt * 2);
      // align with the ground under the three legs
      const q = new THREE.Quaternion().setFromUnitVectors(sUp, this.landGround?.n ?? up);
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
      const g2 = this.landGround ? Math.max(this.landGround.h, this.surfaceH(b, up2) - 0.6) : this.surfaceH(b, up2);
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
          if (!this.landed) {
            const sea = this.seaLevel(b);
            this.note(sea !== null && this.terrainH(b, up2) < sea ? `Amerizaje en ${def.name}: la nave flota en el agua` : `Aterrizaje en ${def.name}`);
            this.sfx.play('land');
            this.arrived(b);
          }
          this.landed = true;
          this.autoLand = false;
          this.throttle = 0;
          if (this.pendingExit) { this.pendingExit = false; this.exitShip(); }
        }
      }
      // buildings and structures: the ship rests on a flat roof, or is pushed out of walls and towers
      const hit = def.id === 'earth' ? this.ruins.shipCollide(this.shipPos, this.shipVel, clearance) : null;
      this.alien.shipCollide(this.shipPos, this.shipVel);
      if (hit === 'roof' && !this.landed && (this.shipVel.length() < 6 || this.autoLand)) {
        this.note('Aterrizaje en un tejado');
        this.sfx.play('land');
        this.onRoof = true;
        this.landed = true;
        this.autoLand = false;
        this.throttle = 0;
        if (this.pendingExit) { this.pendingExit = false; this.exitShip(); }
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

  /** what a place takes from the suit each second at `p` (negative heals: Earth's air in exploration) */
  hazardDrain(b: Body, p: THREE.Vector3) {
    const def = b.def;
    if (def.id === 'earth') return this.surv ? 0 : -5;
    if (def.id === 'mercury') {
      // the day side bakes, the night side freezes
      const up = _v1.copy(p).sub(b.pos).normalize();
      return _v2.copy(this.sunBody.pos).sub(p).normalize().dot(up) > 0 ? 2.2 : 0.8;
    }
    return def.hazard?.suitDrain ?? 0.05;
  }
  /** the height (over the radius) the astronaut stands at, in direction `up`: the ground, or swimming at a sea's surface */
  private footFloor(b: Body, up: THREE.Vector3) {
    const h = this.terrainH(b, up), sea = this.seaLevel(b);
    return sea !== null && h < sea - 0.9 ? sea - SWIM_DEPTH : h;
  }

  private exitShip() {
    const b = this.nearest;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.shipQ);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.shipQ);
    // out of the hatch on whichever side is free: never inside a building, a monolith or the Spire
    const p = new THREE.Vector3(), up = new THREE.Vector3();
    const tryAt = (side: number, back: number) => {
      p.copy(this.shipPos).addScaledVector(right, side).addScaledVector(fwd, -back);
      up.copy(p).sub(b.pos).normalize();
      p.copy(b.pos).addScaledVector(up, b.def.radius + this.footFloor(b, up) + 0.05);
      return !this.solidAt(_v1.copy(p).addScaledVector(up, 0.9));
    };
    const gearH = this.shipPos.distanceTo(b.pos) - 2.7;
    const tryNear = (side: number, back: number) => tryAt(side, back) && p.distanceTo(b.pos) > gearH - 3;
    const ground = !this.onRoof && (tryNear(9.5, 2) || tryNear(-9.5, 2) || tryNear(0, -9) || tryNear(0, 11) || tryAt(9.5, 2) || tryAt(-9.5, 2));
    if (!ground) {
      // landed on a roof: step out onto it, next to the ship
      const sUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.shipQ);
      p.copy(this.shipPos).addScaledVector(right, 6).addScaledVector(sUp, -2.6);
      up.copy(p).sub(b.pos).normalize();
    }
    this.playerPos.copy(p);
    this.playerVel.set(0, 0, 0);
    this.camFwd.copy(fwd).addScaledVector(up, -fwd.dot(up)).normalize();
    this.playerFacing.copy(this.camFwd);
    this.camPitch = -0.2;
    this.mode = 'foot';
    this.onGround = true;
    this.fuel = 100;
    this.swimming = false;
    this.note(`Has bajado en ${b.def.name} · gravedad ${b.def.gravity} m/s²`);
    if (b.def.hazard?.text) this.note(`⚠ ${b.def.hazard.text}`);
    this.arrived(b);
  }

  /** K with a point chosen on this same world: up above the air, across, and down next to it (both modes) */
  private startHop(): boolean {
    const id = this.waypoint?.id;
    const pt = id ? this.placePoint(id) : null;
    const b = this.nearest;
    if (!pt || pt.b !== b || b.def.kind !== 'rocky' || this.warp) return false;
    const R = b.def.radius;
    const from = this.shipPos.clone().sub(b.pos);
    const r0 = from.length();
    from.divideScalar(r0);
    const full = from.angleTo(pt.dir);
    const dist = full * R;
    if (dist < 1500) { this.note('Ya estás junto al punto: aterriza con {KeyE}'); return true; }
    // it lands ~35 m short of the point, never on top of a terminal or a monolith
    const ang = Math.max(0, full - 35 / R);
    const fuel = this.hopFuel(dist);
    if (this.surv && fuel !== null) {
      if (this.surv.fuel < fuel + 1) { this.note(`Combustible insuficiente para el vuelo suborbital (${fuel.toFixed(0)}%)`); return true; }
      this.surv.fuel -= fuel;
    }
    const h0 = Math.max(0, r0 - R - this.surfaceH(b, from));
    const peak = Math.max(h0, clamp(dist * 0.06, 25e3, 400e3), (b.def.atmo?.height ?? 0) * 1.2);
    const T = this.hopTime(dist);
    this.hop = { b, from, to: pt.dir.clone(), ang, t: 0, T, peak, h0 };
    this.landed = false;
    this.autoLand = false;
    this.pendingExit = false;
    this.throttle = 0;
    this.surv?.vega.say(VEGA.suborbital, 'suborbital', { once: true });
    if (id && VEGA_HOP[id]) this.surv?.vega.say(VEGA_HOP[id], `hop:${id}`, { once: true });
    this.note(`Vuelo suborbital hacia ${this.waypoint!.name}: ${formatDist(dist)} · ≈ ${Math.round(T)} s${fuel ? ` · combustible ${fuel.toFixed(0)}%` : ''} · {KeyK}: cancelar`);
    this.sfx.play('whoosh', undefined, 1);
    return true;
  }
  private hopTime(dist: number) { return clamp(25 + dist / 120e3, 25, 120); }
  /** survival: a small fixed cost (1% every 500 km, 20% at most) */
  private hopFuel(dist: number) { return this.surv ? Math.min(20, 1 + dist / 500e3) * this.surv.mods().fuel : null; }
  private updateHop(dt: number) {
    const h = this.hop!, b = h.b, R = b.def.radius;
    if (this.nearest !== b || this.dead) { this.hop = null; return; }
    h.t += dt;
    const s = clamp(h.t / h.T, 0, 1);
    const e = s * s * (3 - 2 * s);
    // along the great circle, a smooth arc: up to the peak, down to 250 m over the place
    const axis = new THREE.Vector3().crossVectors(h.from, h.to);
    if (axis.lengthSq() < 1e-12) axis.set(h.from.y, -h.from.x, 0).add(new THREE.Vector3(0, h.from.z, -h.from.y));
    axis.normalize();
    const dir = h.from.clone().applyAxisAngle(axis, h.ang * e);
    const endAlt = 250;
    // the height rises (and falls) much faster than the ground goes by: it leaves the thick air almost vertically
    const alt = h.h0 + (endAlt - h.h0) * e + Math.max(0, h.peak - Math.max(h.h0, endAlt)) * Math.pow(Math.sin(Math.PI * e), 0.3);
    const prev = this.shipPos.clone();
    this.shipPos.copy(b.pos).addScaledVector(dir, R + this.surfaceH(b, dir) + alt);
    this.shipVel.copy(this.shipPos).sub(prev).divideScalar(Math.max(dt, 1e-4));
    this.altitude = alt;
    // the nose follows the path, the belly towards the ground
    const v = this.shipVel.clone();
    if (v.lengthSq() > 1) {
      const m = new THREE.Matrix4().lookAt(ZERO, v.normalize(), dir);
      this.shipQ.slerp(new THREE.Quaternion().setFromRotationMatrix(m), 1 - Math.exp(-dt * 3));
    }
    this.throttle = 0.5;
    if (s >= 1) {
      this.hop = null;
      this.shipVel.set(0, 0, 0);
      this.throttle = 0;
      this.autoLand = true;
      this.note(`Llegada: ${this.waypoint?.name ?? b.def.name}. Aterrizando…`);
    }
  }

  /** a world's ground under the ship's three legs: their mean height and the plane they make (it rests on slopes) */
  private groundUnderGear(b: Body) {
    let hs = 0;
    const pts: THREE.Vector3[] = [];
    for (const [x, z] of [[0, -5], [-2.3, 3.5], [2.3, 3.5]]) {
      const d = new THREE.Vector3(x, 0, z).applyQuaternion(this.shipQ).add(this.shipPos).sub(b.pos).normalize();
      const h = this.surfaceH(b, d);
      hs += h;
      pts.push(d.multiplyScalar(b.def.radius + h));
    }
    const n = new THREE.Vector3().crossVectors(pts[1].clone().sub(pts[0]), pts[2].clone().sub(pts[0])).normalize();
    const up = this.shipPos.clone().sub(b.pos).normalize();
    if (n.dot(up) < 0) n.negate();
    // never leaning more than ~16°
    if (n.dot(up) < 0.96) n.lerp(up, 0.5).normalize();
    return { h: hs / 3, n };
  }
  private landGround: { h: number; n: THREE.Vector3 } | null = null;

  /** the ship (on foot, far from it, adrift after a jump that went too high) comes to you on its autopilot */
  private recallShip() {
    if (this.surv) {
      if (this.surv.fuel < 4) { this.note('Sin combustible para traer la nave'); return; }
      this.surv.fuel -= 4;
    }
    const up = this.playerPos.clone().sub(this.nearest.pos).normalize();
    this.shipPos.copy(this.playerPos).addScaledVector(up, 4);
    this.shipVel.set(0, 0, 0);
    const m = new THREE.Matrix4().lookAt(ZERO, this.camFwd.clone().projectOnPlane(up).normalize(), up);
    this.shipQ.setFromRotationMatrix(m);
    this.camQ.copy(this.shipQ);
    this.mode = 'ship';
    this.landed = false;
    this.throttle = 0;
    this.swimming = false;
    this.note('La nave vino a recogerte con el piloto automático. A bordo');
  }

  /** a world visited for the first time (exploration): a soft card with a few of its real facts */
  arrived(b: Body) {
    if (this.surv || this.seen.has(b.def.id) || b.def.kind === 'star') return;
    this.seen.add(b.def.id);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...this.seen])); } catch { /* ignore */ }
    this.card = { title: b.def.name, lines: b.def.facts.slice(0, 2), t: this.simTime };
  }

  private updateFoot(dt: number) {
    const b = this.nearest;
    const def = b.def;
    const up = this.playerPos.clone().sub(b.pos);
    const rNow = up.length();
    up.divideScalar(rNow);
    // gravity weakens with the distance (inverse square): from a small moon a strong push escapes for good
    const g = def.gravity * (def.radius / Math.max(rNow, def.radius)) ** 2;
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
    const swim = this.swimming;
    const speed = swim ? (run ? 2.2 : 1.3) : (run ? 8.5 : 4.2) * (def.gravity < 2 ? 0.8 : 1);
    const vr = this.playerVel.dot(up);
    const vt = this.playerVel.clone().addScaledVector(up, -vr);
    // the jetpack's own push (it does not weaken with height), up with Space, down with C
    const thrust = Math.max(def.gravity * 1.35, def.gravity + 3);
    const jetOK = !this.onGround && !swim && this.fuel > 0 && this.airTime > 0.25;
    const jetUp = jetOK && k.has('Space'), jetDown = jetOK && k.has('KeyC') && !jetUp;
    if (this.onGround) {
      vt.lerp(mv.clone().multiplyScalar(moving ? speed : 0), 1 - Math.exp(-dt * (swim ? 3 : 10)));
      this.playerVel.copy(vt);
      this.airTime = 0;
      this.fuel = Math.min(100, this.fuel + dt * 30);
      if (this.pressed.has('Space') && !swim) {
        this.playerVel.addScaledVector(up, Math.min(4.6, Math.sqrt(2 * g * 1.0) + 0.5) + (def.gravity < 2 ? 0.8 : 0));
        this.onGround = false;
      }
    } else {
      this.airTime += dt;
      vt.addScaledVector(mv, dt * 3);
      this.playerVel.copy(vt).addScaledVector(up, vr - g * dt);
      if (jetUp || jetDown) {
        this.playerVel.addScaledVector(up, (jetUp ? 1 : -1) * thrust * dt);
        this.playerVel.addScaledVector(mv, dt * 4);
        this.fuel = Math.max(0, this.fuel - dt * 16);
      }
    }
    for (const j of this.astro.jet) {
      j.visible = jetUp || jetDown;
      j.rotation.x = jetDown ? Math.PI : 0; // pushing down: the flames point up
    }
    // a short push (the survival dash): replaces the walking speed for its moment, the collisions below still apply
    const fi = this.footImpulse;
    if (fi) {
      const d = fi.dir.clone().projectOnPlane(up);
      if (d.lengthSq() > 1e-6) {
        const vv = this.playerVel.dot(up);
        this.playerVel.copy(d.normalize().multiplyScalar(fi.speed)).addScaledVector(up, vv);
      }
      fi.t -= dt;
      if (fi.t <= 0) this.footImpulse = null;
    }
    const wasGround = this.onGround;
    this.playerPos.addScaledVector(this.playerVel, dt);
    const up2 = this.playerPos.clone().sub(b.pos);
    const r = up2.length();
    up2.divideScalar(r);
    const hT = this.terrainH(b, up2);
    const sea = this.seaLevel(b);
    const inSea = sea !== null && hT < sea - 0.9;
    let gr = def.radius + (inSea ? sea - SWIM_DEPTH : hT);
    const vr2 = this.playerVel.dot(up2);
    const fall = (v: number) => {
      // water takes a fall well; ground does not
      if (v > (inSea ? 25 : 11) && !wasGround) {
        this.suit -= (v - (inSea ? 25 : 11)) * 6;
        this.hurt = Math.max(this.hurt, 0.5);
        this.hurtDir = null;
        this.sfx.play('hurt');
        this.note('¡Caída fuerte!');
      }
    };
    if (r <= gr) {
      this.playerPos.copy(b.pos).addScaledVector(up2, gr);
      if (vr2 < 0) {
        fall(-vr2);
        this.playerVel.addScaledVector(up2, -vr2);
      }
      this.onGround = true;
    } else if (this.onGround && r - gr < 0.4 && vr2 <= 0.3) {
      this.playerPos.copy(b.pos).addScaledVector(up2, gr);
      this.playerVel.addScaledVector(up2, -vr2);
    } else {
      this.onGround = false;
    }
    if (def.id === 'earth') {
      // the flat roofs of the ruins hold you up like the ground
      const roof = this.ruins.roof(this.playerPos);
      const vv = this.playerVel.dot(up2);
      if (roof !== null && vv <= 0.3 && (roof >= 0 ? roof < 1.2 : wasGround && roof > -0.4)) {
        this.playerPos.addScaledVector(up2, roof);
        if (vv < 0) { fall(-vv); this.playerVel.addScaledVector(up2, -vv); }
        this.onGround = true;
        gr = this.playerPos.distanceTo(b.pos);
      }
      this.ruins.collide(this.playerPos, this.playerVel);
    }
    this.alien.collide(this.playerPos, this.playerVel);
    const swimNow = inSea && r - gr < 0.6;
    if (swimNow && !this.swimming) {
      this.sfx.play('splash');
      if (this.surv) this.surv.vega.say(VEGA.swim, 'swim', { once: true });
      else this.note(sea !== null && def.id === 'titan' ? 'Metano líquido a −179 °C: el traje te mantiene a flote' : 'En el agua: el traje flota, nadar es lento');
    }
    this.swimming = swimNow;
    this.altitude = this.playerPos.distanceTo(b.pos) - gr;
    // facing / animation
    const tSpeed = vt.length();
    if (moving) this.playerFacing.lerp(mv, 1 - Math.exp(-dt * 10)).normalize();
    this.walkPhase += dt * tSpeed * (swim ? 3.2 : def.gravity < 2 ? 1.6 : 2.4);
    const amp = this.onGround ? Math.min(1, tSpeed / 4) : 0.25;
    const s = Math.sin(this.walkPhase);
    if (swim) {
      // a slow crawl: arms reaching forward, legs kicking
      this.astro.legL.rotation.x = s * 0.4;
      this.astro.legR.rotation.x = -s * 0.4;
      this.astro.armL.rotation.x = -1.9 + s * 0.6;
      this.astro.armR.rotation.x = -1.9 - s * 0.6;
    } else {
      this.astro.legL.rotation.x = s * 0.75 * amp;
      this.astro.legR.rotation.x = -s * 0.75 * amp;
      this.astro.armL.rotation.x = -s * 0.55 * amp;
      this.astro.armR.rotation.x = s * 0.55 * amp;
    }
    // footsteps: a soft crunch at each step, darker on ice and dust
    const step = Math.floor(this.walkPhase / Math.PI);
    if (step !== this.stepPhase) {
      this.stepPhase = step;
      if (this.onGround && !swim && tSpeed > 0.6) this.sfx.play('step', undefined, STEP_TONE[def.id] ?? 0.6);
    }
    // hazards (Earth's air is breathable: it heals in exploration and costs nothing in survival)
    const d = this.hazardDrain(b, this.playerPos);
    this.suitDrain = d;
    this.suit = clamp(this.suit - d * dt, -1, 100);
    if (this.suit <= 0) {
      this.die(def.id === 'venus' ? 'El traje colapsó bajo 92 bar de presión y 464 °C. Ningún humano podría sobrevivir en la superficie de Venus.' : `Tu traje espacial falló en ${def.name}: ${def.hazard?.text || 'daños críticos'}.`);
    }
    // a minute adrift: the pack can push down too
    if (!this.onGround && this.airTime > 60 && !this.airHint) {
      this.airHint = true;
      if (this.surv) this.surv.vega.say(VEGA.airborne, 'airborne', { once: true });
      else this.note('Llevas un minuto en el aire: {KeyC} empuja la mochila hacia abajo. Si te alejas demasiado, {KeyE} trae la nave');
    }
    if (this.onGround) this.airHint = false;
    // re-enter ship (or, adrift and far from it, call it)
    if (this.pressed.has('KeyE')) {
      const dShip = this.playerPos.distanceTo(this.shipPos);
      if (dShip < 14) {
        this.mode = 'ship';
        this.landed = true;
        this.swimming = false;
        this.note('A bordo de la nave');
        this.saveExplore();
      } else if (!this.onGround && this.airTime > 20) this.recallShip();
      else this.note(`La nave está a ${formatDist(dShip)}`);
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
    }
    const ds = p.distanceTo(this.sunBody.pos);
    const Rs = this.sunBody.def.radius;
    const star = this.sunBody.def.star ?? SUN_STAR;
    if (def.kind === 'star') {
      this.pressureNow = 0;
      // radiative equilibrium temperature of a body at this distance from the star
      this.tempNow = star.teff * Math.sqrt(Rs / (2 * Math.max(ds, Rs))) - 273;
    }
    // Sun heat. You may fly as close as you like; inside 3 solar radii (from the
    // centre) the hull starts to burn, faster the closer you get, and touching the
    // photosphere destroys the ship outright.
    if (ds < Rs * 3 && this.mode === 'ship') {
      const f = (Rs * 3) / ds;
      this.warnings.push(ds < Rs * 1.8 ? 'CASCO FUNDIÉNDOSE · ALÉJATE DE LA ESTRELLA' : 'TEMPERATURA DEL CASCO CRÍTICA');
      this.hull -= dt * (f * f - 1) * 10;
      const sn = this.sunBody.def.name;
      const tC = Math.round((star.teff - 273) / 100) * 100;
      if (ds < Rs * 1.05) this.die(`La nave se desintegró al rozar la fotosfera de ${sn}: ${tC.toLocaleString('es-ES')} °C y un flujo de energía miles de veces mayor que en la Tierra.`);
      else if (this.hull <= 0) this.die(`La nave se vaporizó por el calor de ${sn}. A esta distancia la radiación funde cualquier material conocido.`);
    }
    if (this.hull < 30 && !this.dead && this.mode === 'ship') this.warnings.push(`INTEGRIDAD DEL CASCO ${this.hull.toFixed(0)}%`);
    if (this.mode === 'foot' && this.suit < 40) this.warnings.push(`${this.surv ? 'SALUD' : 'INTEGRIDAD DEL TRAJE'} ${Math.max(0, this.suit).toFixed(0)}%`);
    if (this.mode === 'ship' && this.hull <= 0) this.die('La nave quedó destruida.');
    void dt;
  }

  // -------------------------------------------------------------------------
  private updateCamera(dt: number) {
    const b = this.nearest;
    let eye: THREE.Vector3;
    let lookQ: THREE.Quaternion;
    const fp = this.vision && this.visionMode === 'eyes';
    let anchor: THREE.Vector3;
    if (this.mode === 'ship') {
      this.camQ.slerp(this.shipQ, 1 - Math.exp(-dt * (this.warp ? 4 : 7)));
      const oq = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.orbitPitch, this.orbitYaw, 0, 'YXZ'));
      const q = this.camQ.clone().multiply(oq);
      // vision mode: from the cockpit (the ship itself is hidden)
      const off = fp
        ? new THREE.Vector3(0, 1.1, -2.6).applyQuaternion(q)
        : new THREE.Vector3(0, this.camDistShip * 0.2, this.camDistShip).applyQuaternion(q);
      eye = this.shipPos.clone().add(off);
      anchor = this.shipPos.clone();
      this.camOff.copy(off);
      lookQ = fp ? q.clone() : q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.1, 0, 0)));
    } else {
      const up = this.playerPos.clone().sub(b.pos).normalize();
      const right = new THREE.Vector3().crossVectors(this.camFwd, up).normalize();
      const look = this.camFwd.clone().multiplyScalar(Math.cos(this.camPitch)).addScaledVector(up, Math.sin(this.camPitch));
      // vision mode: through the astronaut's own eyes (the astronaut is hidden)
      const side = fp ? 0 : 0.45, back = fp ? 0 : this.camDistFoot, eyeH = fp ? 1.62 : 1.55;
      const tgt = this.playerPos.clone().addScaledVector(up, eyeH).addScaledVector(right, side);
      eye = tgt.clone().addScaledVector(look, -back);
      anchor = tgt;
      this.camOff.set(0, 0, 0).addScaledVector(up, eyeH).addScaledVector(right, side).addScaledVector(look, -back);
      const m = new THREE.Matrix4().lookAt(ZERO, look, up);
      lookQ = new THREE.Quaternion().setFromRotationMatrix(m);
    }
    // a building or a structure between the player (or the ship) and the camera pulls the camera in
    if (!fp && b.def.kind === 'rocky' && this.altitude < 600) {
      const seg = eye.clone().sub(anchor);
      for (let i = 1; i <= 8; i++) {
        const f = i / 8;
        if (!this.solidAt(_v2.copy(anchor).addScaledVector(seg, f))) continue;
        const minD = this.mode === 'ship' ? 10 : 0.8;
        eye.copy(anchor).addScaledVector(seg, Math.max(minD / Math.max(seg.length(), 1e-3), f - 0.14));
        this.camOff.copy(eye).sub(this.mode === 'ship' ? this.shipPos : this.playerPos);
        break;
      }
    }
    // keep camera above ground (and above the water)
    if (b.def.kind === 'rocky') {
      const d = eye.clone().sub(b.pos);
      const rr = d.length();
      d.divideScalar(rr);
      const minR = b.def.radius + this.surfaceH(b, d) + 0.6;
      if (rr < minR) {
        eye.copy(b.pos).addScaledVector(d, minR);
        this.camOff.copy(eye).sub(this.mode === 'ship' ? this.shipPos : this.playerPos); // near ground: precise anyway
      }
    }
    this.lastCamWorld.copy(this.camWorld);
    this.camWorld.copy(eye);
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.copy(lookQ);
    const fov = fp ? this.visionFov : this.warp ? 65 + 8 * Math.min(1, this.warpSpeed / (C_LIGHT * 20)) : 65;
    if (Math.abs(this.camera.fov - fov) > 0.002 * fov) {
      // eased in log space, so a 50x zoom feels as smooth as a small one
      const lf = Math.log(this.camera.fov);
      this.camera.fov = Math.exp(lf + (Math.log(fov) - lf) * Math.min(1, dt * (this.vision ? 6 : 3)));
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  private respawnStreak(i: number, initial: boolean) {
    const a = Math.random() * Math.PI * 2;
    const rad = 16 + Math.random() * 54;
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
    const starDef = this.sunBody.def.star ?? SUN_STAR;
    const dAU = this.starAU(sunDist);
    const sunI = 3.3 * Math.pow(1 / Math.max(dAU * dAU, 0.05), 0.3);

    // world -> view rotation (the camera sits at the origin), for lights given in view space
    const toView = this.camera.quaternion.clone().invert();
    // inside an atmosphere, other worlds are seen through it (a red moonrise)
    const inAir = !!(b.def.atmo && b.def.kind === 'rocky' && camAlt < b.def.atmo.height);
    // night adaptation of the eye (the same twilight ramp as the night floor)
    const darkEyes = 1 - smoothstep(-0.035, 0.005, sunEl);
    const lightTint = starDef.lightTint;

    // body placement & uniforms
    for (const body of this.bodies) {
      // only this system's worlds are drawn: the others are far below a pixel (shown as points of light)
      body.root.visible = body.def.kind === 'star' || body.star === this.sunBody;
      body.root.position.copy(body.pos).sub(cw);
      if (!body.root.visible) continue;
      const bR = body.def.radius;
      const bSun = _v1.copy(sunPos).sub(body.pos).normalize();
      const bAU = this.starAU(sunPos.distanceTo(body.pos));
      const bSunI = 3.3 * Math.pow(1 / Math.max(bAU * bAU, 0.05), 0.3);
      const rel = _v2.copy(body.pos).sub(cw);
      if (body.atmoMat) {
        const u = body.atmoMat.uniforms;
        u.uCenter.value.copy(rel).divideScalar(bR);
        u.uSunDir.value.copy(bSun);
        u.uSun.value = body.def.atmo!.sun * Math.pow(1 / Math.max(bAU * bAU, 0.05), 0.3);
        u.uSunTint.value.set(...(body.star.def.star ?? SUN_STAR).lightTint);
        const inside = rel.length() < bR + body.def.atmo!.height;
        const side = inside ? THREE.BackSide : THREE.FrontSide;
        if (body.atmoMat.side !== side) { body.atmoMat.side = side; body.atmoMat.needsUpdate = true; }
        u.uFade.value = body.def.kind === 'gas' ? clamp(1 + (rel.length() - bR) / 3000, 0, 1) : 1;
      }
      if (body.gasMat) {
        const u = body.gasMat.uniforms;
        u.uCenter.value.copy(rel).divideScalar(bR);
        // the planet turns as a whole at its real rate (Jupiter: once every 9.9 h)
        _q1.copy(body.tiltQ).multiply(_q2.setFromAxisAngle(Y_AXIS, this.time * (body.def.spin ?? 0)));
        u.uInvRot.value.setFromMatrix4(_m1.makeRotationFromQuaternion(_q1.invert()));
        u.uSunDir.value.copy(bSun);
        u.uSunI.value = bSunI * 0.95;
        this.setEclipse(u, body, bSun, bR, ZERO, null);
        const inside = rel.length() < bR * 1.002;
        const side = inside ? THREE.BackSide : THREE.FrontSide;
        if (body.gasMat.side !== side) { body.gasMat.side = side; body.gasMat.needsUpdate = true; }
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
        u.uSunTint.value.set(...(body.star.def.star ?? SUN_STAR).lightTint);
        u.uBelow.value = rel.length() < bR + body.def.clouds!.alt ? 1 : 0;
        u.uShellR.value = (bR + body.def.clouds!.alt) / bR;
        u.uNightAmb.value.set(0, 0, 0); // the player's own sky sets it below
        this.setEclipse(u, body, bSun, bR, ZERO, null);
        // the weather drifts with the wind (Venus' cloud deck super-rotates at ~100 m/s)
        const drift = CLOUD_DRIFT[body.def.clouds!.type] ?? 0;
        body.clouds!.quaternion.copy(body.tiltQ).multiply(_q2.setFromAxisAngle(Y_AXIS, this.time * drift));
      }
      if (body.tUniforms) {
        const u = body.tUniforms;
        u.uDetailOffset.value.set(posMod(cw.x - body.pos.x, 256), posMod(cw.y - body.pos.y, 256), posMod(cw.z - body.pos.z, 256));
        u.uFogDensity.value = 0;
        u.uNight.value = 0;
        // seen from afar, a world is lit by its own sunlight, not by the scene light that
        // fades out at the player's night (the Moon must shine in Earth's night sky)
        u.uDirScale.value = 0;
        u.uFarSun.value.set(lightTint[0] * bSunI, lightTint[1] * bSunI, lightTint[2] * bSunI);
        u.uFarSunDir.value.copy(bSun).applyQuaternion(toView);
        if (inAir && body !== b) {
          u.uFarSun.value.multiply(this.atmoTransmittance(b, _v3.copy(rel).normalize(), _v4));
          // eyes used to the dark: next to a moonlit landscape the Moon looks dazzling white
          u.uFarSun.value.multiplyScalar(1 + 1.2 * darkEyes);
        }
        this.setEclipse(u as unknown as Record<string, THREE.IUniform>, body, bSun, 1, _v3.copy(rel).applyQuaternion(toView), toView);
      }
      if (body.waterMat) {
        const u = body.waterMat.uniforms;
        u.uOffset.value.set(posMod(cw.x - body.pos.x, 1000), posMod(cw.y - body.pos.y, 1000), posMod(cw.z - body.pos.z, 1000));
        u.uTime.value = this.time;
        u.uSunDir.value.copy(bSun);
        u.uFogDensity.value = 0;
        this.setEclipse(u, body, bSun, 1, rel, null);
        // its own sunlight and daytime sky (the shader fades the sky with the water's own sun elevation);
        // the nearest body overrides these below with the local values and the night floor
        const tint = starDef.lightTint;
        u.uSunColor.value.set(tint[0] * bSunI, tint[1] * bSunI, tint[2] * bSunI);
        const fc = body.def.atmo?.fogColor ?? [0, 0, 0];
        u.uSky.value.set(fc[0], fc[1], fc[2]).multiplyScalar(bSunI * 0.3 + 0.005);
        u.uSkyNight.value.set(0, 0, 0);
      }
    }
    // stars: surface animation + halo. The halo keeps a fixed angular size out to
    // ~60 AU, shrinks to a point at interstellar range, and never grows beyond a
    // modest multiple of the disc up close.
    // Auto-exposure: when a star fills a large part of the view the camera stops
    // down, like a real one, instead of bleaching the whole frame white.
    const angRad = Math.asin(Math.min(1, this.sunBody.def.radius / Math.max(sunDist, 1)));
    const expTarget = clamp(0.05 / Math.max(angRad, 1e-4), 0.2, 1);
    this.autoExp += (expTarget - this.autoExp) * Math.min(1, dt * 3);
    this.renderer.toneMappingExposure = this.baseExposure * this.autoExp;
    // the bloom budget and strength follow the exposure, otherwise a disc that
    // fills the view still veils the whole frame and bleaches a red star white
    const ae = this.autoExp;
    (this.bloom.highPassUniforms as Record<string, THREE.IUniform>).heliosMax.value = (this.lightsMode === 'comfort' ? 6 : 16) * ae * ae;
    this.bloom.strength = (this.lightsMode === 'comfort' ? 0.25 : 0.55) * (0.4 + 0.6 * ae);
    const tint = new THREE.Vector3();
    for (const st of this.starBodies) {
      st.starMat!.uniforms.uTime.value = this.time;
      st.coronaMat!.uniforms.uTime.value = this.time;
      const rel = st.pos.clone().sub(cw);
      st.coronaMat!.uniforms.uCenter.value.copy(rel);
      const d = rel.length();
      const Rs = st.def.radius;
      const far = clamp((60 * AU) / d, 0.03, 1);
      st.glow!.scale.setScalar(Math.max(Rs * 2.4, d * 0.035 * far));
      st.glow2!.scale.setScalar(Math.max(Rs * 4.5, d * 0.14 * far));
      // seen from inside an atmosphere the star is reddened and dimmed
      this.atmoTransmittance(b, rel.divideScalar(d), tint);
      st.starMat!.uniforms.uTint.value.copy(tint);
      st.coronaMat!.uniforms.uTint.value.copy(tint);
      (st.glow!.material as THREE.SpriteMaterial).color.copy(st.glowBase!).multiplyScalar(this.glowFactor).multiply(new THREE.Color(tint.x, tint.y, tint.z));
      (st.glow2!.material as THREE.SpriteMaterial).color.copy(st.glow2Base!).multiplyScalar(this.glowFactor).multiply(new THREE.Color(tint.x, tint.y, tint.z));
    }

    // lighting at the camera / focus
    const hor = camAlt > 0 ? Math.acos(clamp(def.radius / camR, -1, 1)) : 0;
    let shadowF = def.kind === 'star' ? 1 : smoothstep(-Math.sin(hor) - 0.03, -Math.sin(hor) + 0.02, sunEl);
    // Near the ground the shadow map covers only a few dozen metres, so it cannot
    // stop a Sun that is already below the horizon from lighting slopes and rocks
    // tilted towards it (bright far hills and rock sides at night while nearby
    // things were black). Fade the sunlight through twilight using the local
    // horizon instead; the shadow map keeps handling daytime shadows.
    if (camAlt < 3000 && def.kind !== 'star') shadowF = smoothstep(-0.035, 0.005, sunEl);
    const lc = new THREE.Color(...starDef.lightTint);
    // an eclipse over the player (a moon in front of the Sun, or the planet's shadow on a
    // moon) dims the sunlight, the sky and the haze together
    const ecl = def.kind === 'star' ? 1 : this.eclipseAt(b, cw);
    if (b.atmoMat) b.atmoMat.uniforms.uSun.value *= ecl;
    // a cloud between the player and the Sun shades everything around them (the ground
    // further away gets its own cloud shadows in the terrain shader)
    const cloudCam = this.cloudShadowAt(b, cw, sunDir);
    let li = sunI * ecl * cloudCam;
    let fogDensity = 0;
    const fogC = new THREE.Color(0, 0, 0);
    // horizon sky towards the Sun, across and away from it (linear radiance), and the
    // Sun's azimuth; turned into the haze colour law below
    const l0 = new THREE.Vector3(), l90 = new THREE.Vector3(), l180 = new THREE.Vector3();
    const sunAz = sunDir.clone().addScaledVector(up, -sunEl);
    if (sunAz.lengthSq() < 1e-10) sunAz.set(up.y, -up.x, 0).add(new THREE.Vector3(0, up.z, -up.y));
    sunAz.normalize();
    let hemiI = 0;
    let starAlpha = 1;
    const a = def.atmo;
    if (a && def.kind === 'rocky') {
      const dens = Math.exp(-Math.max(0, camAlt) / a.HR);
      const day = smoothstep(-0.12, 0.25, sunEl);
      // Sunlight crossing the air above the player: golden, then deep red and dim at sunset
      // (blue on Mars, whose dust scatters red). Normalised by the zenith path, so the
      // daylight colour at noon stays exactly as before.
      const tS = this.atmoTransmittance(b, sunDir, new THREE.Vector3());
      const tZ = this.atmoTransmittance(b, up, new THREE.Vector3());
      lc.setRGB(lc.r * Math.min(1, tS.x / tZ.x), lc.g * Math.min(1, tS.y / tZ.y), lc.b * Math.min(1, tS.z / tZ.z));
      // Aerial perspective: the haze is the horizon sky itself, sampled towards the Sun,
      // across and away from it (as seen from the top of the air when in orbit)
      fogDensity = a.fogDensity;
      fogC.setRGB(a.fogColor[0], a.fogColor[1], a.fogColor[2]).multiplyScalar((day * 0.42 + 0.004) * sunI * Math.min(1, a.skyBrightness + 0.2));
      const ro = cw.clone().sub(b.pos);
      if (ro.length() > def.radius + a.height) ro.setLength(def.radius + a.height - 1);
      const skySun = a.sun * Math.pow(1 / Math.max(dAU * dAU, 0.05), 0.3) * ecl;
      this.skyRadiance(b, ro, sunAz, sunDir, skySun, l0);
      this.skyRadiance(b, ro, sunAz.clone().negate(), sunDir, skySun, l180);
      this.skyRadiance(b, ro, new THREE.Vector3().crossVectors(up, sunAz), sunDir, skySun, l90);
      // the haze takes the colour of the star's light like the sky does
      const tintV = new THREE.Vector3(...starDef.lightTint);
      l0.multiply(tintV); l180.multiply(tintV); l90.multiply(tintV);
      hemiI = day * dens * 0.9 * a.skyBrightness;
      // stars come out as the sky overhead really darkens (twilight), never in daylight,
      // even on a mountain top
      // (zenith luminance: ~0.14 by day, 0.005 with the Sun 3° below the horizon, 2e-4 at -6°)
      const lz = this.skyRadiance(b, ro, up, sunDir, skySun, new THREE.Vector3());
      const zenY = Math.max(0.2126 * lz.x + 0.7152 * lz.y + 0.0722 * lz.z, 1e-9);
      starAlpha = 1 - smoothstep(Math.log(1e-4), Math.log(0.01), Math.log(zenY));
      if (def.clouds && (def.id === 'venus' || def.id === 'titan')) {
        const below = camAlt < def.clouds.alt - def.clouds.thickness;
        if (below) {
          li *= def.id === 'venus' ? 0.14 : 0.1;
          lc.setRGB(1, 0.68, 0.38);
          hemiI = (def.id === 'venus' ? 1.2 : 0.8) * day;
          starAlpha = 0;
          fogC.setRGB(a.fogColor[0], a.fogColor[1], a.fogColor[2]).multiplyScalar(sunI * 0.12 * (0.15 + day));
          // under the cloud deck the sky is a dim, even orange glow
          l0.set(fogC.r, fogC.g, fogC.b); l90.copy(l0); l180.copy(l0);
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
        // lightning deep in the clouds: a distant glow that swells and fades over seconds, never a flash
        if (depth > 4000) {
          this.lightningNext -= dt;
          if (this.lightningNext <= 0 && this.lightningAge < 0) { this.lightningAge = 0; this.lightningNext = 4 + Math.random() * 3; }
        }
        if (this.lightningAge >= 0) {
          const la = (this.lightningAge += dt);
          this.lightning = la < 0.5 ? smoothstep(0, 0.5, la) : 1 - smoothstep(0.5, 2, la);
          if (la > 2) { this.lightningAge = -1; this.lightning = 0; }
        }
        const bright = Math.exp(-depth / 25000) * (0.1 + day) * sunI * 0.45;
        const fc = new THREE.Color(a!.fogColor[0], a!.fogColor[1], a!.fogColor[2]).multiplyScalar(bright);
        fc.add(new THREE.Color(0.6, 0.7, 1.0).multiplyScalar(this.lightning * (this.lightsMode === 'comfort' ? 0.06 : 0.15)));
        const heat = smoothstep(80000, 300000, depth);
        fc.add(new THREE.Color(0.25, 0.05, 0.0).multiplyScalar(heat));
        this.setOverlay(fc, clamp(depth / 2500, 0, 0.985));
        li *= Math.exp(-depth / 20000);
      } else if (camAlt < 20000) {
        const fc = new THREE.Color(a!.fogColor[0], a!.fogColor[1], a!.fogColor[2]).multiplyScalar(sunI * 0.4 * smoothstep(-0.1, 0.25, sunEl));
        this.setOverlay(fc, (1 - camAlt / 20000) * 0.45);
      }
    }
    // heat glare when flying close to a star: starts exactly where the hull begins
    // to burn (3 radii from the centre) and whites out the view, slightly yellow,
    // towards the photosphere. The HUD is DOM and stays readable.
    const starHeat = def.kind === 'star' ? clamp((3 - camR / def.radius) / 2, 0, 1) : 0;
    if (starHeat > 0) {
      const comfort = this.lightsMode === 'comfort';
      const warm = new THREE.Color(1.0, 0.9, 0.7).lerp(new THREE.Color(1.0, 1.0, 0.95), starHeat).multiplyScalar(comfort ? 0.85 : 1.3);
      this.setOverlay(warm, Math.pow(starHeat, 1.5) * (comfort ? 0.8 : 0.9));
    }
    if (starHeat <= 0 && !this.inCloud && !(def.kind === 'gas' && camAlt < 20000)) this.setOverlay(fogC, 0);
    li *= shadowF;
    this.light.color.copy(lc);
    this.light.intensity = li;
    // the studio environment map must not make the hull glow at night
    const envF = clamp(li / 3.3, 0.06, 1);
    for (const e of this.ship.envMats) e.mat.envMapIntensity = e.base * envF;
    for (const e of this.astro.envMats) e.mat.envMapIntensity = e.base * envF;
    this.hemi.intensity = hemiI;
    // Night floor on worlds with an atmosphere: a dim, bluish "moonlit" ambient so
    // nearby and distant objects read consistently. Real starlight is ~100 000x
    // weaker than daylight and would tone-map to pure black, so this is a
    // deliberate stylisation; the suit lamp and headlights (F) remain the way to see.
    // The floor exists only near the surface: from orbit the night side of a
    // planet must stay black, as it really is.
    // It also starts only once the sun is really below the horizon: a low sun must
    // keep its long, pitch-black shadows (lunar sunsets).
    // The floor comes in exactly as the near-ground sunlight goes out (same ramp as
    // shadowF), so dusk never dips to black. It stays on while approaching and in
    // orbit (below 1.5 radii) and is gone from afar (6 radii): a distant world shows
    // only its lit crescent, like the Moon in the sky.
    const nightT = 1 - smoothstep(-0.035, 0.005, sunEl);
    const nightFloor = NIGHT_AMBIENT * nightT * (1 - smoothstep(1.5 * def.radius, 6 * def.radius, camAlt));
    if (a && def.kind === 'rocky') {
      this.hemi.intensity = Math.max(hemiI, nightFloor);
      this.hemi.color.lerp(new THREE.Color(0.55, 0.62, 0.8), nightT);
      this.hemi.groundColor.lerp(new THREE.Color(0.18, 0.18, 0.22), nightT);
    }
    this.hemi.position.copy(up);
    this.stars.material instanceof THREE.ShaderMaterial && (this.stars.material.uniforms.uAlpha.value = starAlpha);
    (this.stars.material as THREE.ShaderMaterial).uniforms.uPR.value = this.renderer.getPixelRatio();
    // the catalogue stars are seen from where the player really is (parallax towards Proxima)
    (this.stars.material as THREE.ShaderMaterial).uniforms.uViewer.value.copy(this.sunBody.starAbs).add(cw).divideScalar(PARSEC);
    (this.milky.material as THREE.ShaderMaterial).uniforms.uAlpha.value = starAlpha;
    this.updateGlints(starAlpha, inAir);
    // Haze colour by azimuth a from the Sun: exp(A + B cos a + C cos 2a) through the three
    // samples. Fitting the logarithm keeps it positive and follows the sharp glow around a
    // low Sun (a linear fit went negative in between and left black or pure blue patches).
    const lg = (v: THREE.Vector3) => new THREE.Vector3(Math.log(Math.max(v.x, 1e-7)), Math.log(Math.max(v.y, 1e-7)), Math.log(Math.max(v.z, 1e-7)));
    const g0 = lg(l0), g90 = lg(l90), g180 = lg(l180);
    const gfb = g0.clone().add(g180).multiplyScalar(0.5);
    const hzA = gfb.clone().add(g90).multiplyScalar(0.5);
    const hzB = g0.clone().sub(g180).multiplyScalar(0.5);
    const hzC = gfb.clone().sub(g90).multiplyScalar(0.5);
    // aerial perspective of the ground under the player (terrain: view space, water: world space)
    const setHaze = (u: Record<string, THREE.IUniform>, q: THREE.Quaternion | null) => {
      u.uFogDensity.value = fogDensity;
      u.uFogH.value = a ? Math.max(a.HM * 1.5, 1500) : 1500;
      u.uFogCamH.value = camAlt;
      u.uPlanetR.value = def.radius;
      u.uHzCenter.value.copy(b.pos).sub(cw);
      u.uHzUp.value.copy(up);
      u.uHzSunAz.value.copy(sunAz);
      if (q) for (const k of ['uHzCenter', 'uHzUp', 'uHzSunAz']) (u[k].value as THREE.Vector3).applyQuaternion(q);
      u.uFogA.value.copy(hzA); u.uFogB.value.copy(hzB); u.uFogC.value.copy(hzC);
    };
    if (b.tUniforms) {
      setHaze(b.tUniforms as unknown as Record<string, THREE.IUniform>, toView);
      b.tUniforms.uNight.value = nightFloor / NIGHT_AMBIENT;
      // the ground under the player uses the scene light (its horizon fade and shadow map)
      b.tUniforms.uDirScale.value = 1;
      b.tUniforms.uFarSun.value.set(0, 0, 0);
      if (b.clouds && b.def.clouds?.type === 0) {
        const q = b.clouds.quaternion.clone().invert().multiply(this.camera.quaternion); // view -> cloud frame
        b.tUniforms.uCloudRotView.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
        b.tUniforms.uCloudCam.value = cloudCam;
      }
    }
    // clouds of the player's world catch the same moonlit glow as the ground at night
    if (b.cloudMat) {
      const nf = nightFloor * 0.06;
      b.cloudMat.uniforms.uNightAmb.value.set(0.55 * nf, 0.62 * nf, 0.8 * nf);
    }
    if (b.waterMat) {
      const u = b.waterMat.uniforms;
      setHaze(u, null);
      this.setEclipse(u, b, sunDir, 1, ZERO, null, false); // carried by the scene light
      u.uSunColor.value.set(lc.r * li, lc.g * li, lc.b * li);
      const sky = a ? new THREE.Color(...a.fogColor).multiplyScalar(sunI * 0.3 + 0.005) : new THREE.Color(0, 0, 0);
      u.uSky.value.set(sky.r, sky.g, sky.b); // daytime sky; faded per fragment by the water's own sun elevation
      const nf = nightFloor * 0.08; // moonlit sky on the water at night
      u.uSkyNight.value.set(0.55 * nf, 0.62 * nf, 0.8 * nf);
    }
    // ambient baseline (space is dark)
    if (!a || def.kind !== 'rocky') {
      this.hemi.color.setRGB(0.6, 0.7, 1);
      this.hemi.groundColor.setRGB(0.2, 0.2, 0.25);
      // airless worlds: pitch-black daytime shadows as before, the night floor only after sunset
      this.hemi.intensity = def.kind === 'gas' ? 0.06 : Math.max(0.025, nightFloor);
    }
    // other worlds in the sky keep the plain space baseline (0.025) instead of the local sky/night floor
    for (const body of this.bodies) {
      if (!body.tUniforms) continue;
      body.tUniforms.uHemiScale.value = body === b ? 1 : clamp(0.025 / Math.max(this.hemi.intensity, 1e-4), 0, 1);
    }

    // shadow light follows focus
    const focus = this.camOff.clone().negate();
    this.light.position.copy(focus).addScaledVector(sunDir, 1500);
    this.light.target.position.copy(focus);
    const sc = this.light.shadow.camera;
    const ext = this.mode === 'ship' ? 70 : 45;
    if (sc.right !== ext) {
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
      // Casters (player, ship, rocks, trees; the terrain does not cast) within 300 m
      // towards the Sun, receivers up to 800 m behind the player, so sunset shadows
      // stay long while the depth range, and with it the bias in metres, stays small.
      sc.near = 1500 - 300; sc.far = 1500 + 800;
      sc.updateProjectionMatrix();
    }
    this.light.target.updateMatrixWorld();

    // ship & astronaut
    const sm = this.ship;
    const fpv = this.vision && this.visionMode === 'eyes';
    sm.root.visible = !(fpv && this.mode === 'ship'); // vision mode: seen from the cockpit
    if (this.mode === 'ship') sm.root.position.copy(this.camOff).negate();
    else sm.root.position.copy(this.shipPos).sub(cw);
    sm.root.quaternion.copy(this.shipQ);
    const thr = this.warp ? 2.6 : Math.max(0, this.throttle) * ((this.keys.has('ShiftLeft') ? 1.7 : 1)) + (this.autoLand ? 0.3 : 0);
    for (const f of sm.flames) {
      f.visible = thr > 0.02 && this.mode === 'ship' && !this.landed;
      f.scale.set(1, 1, 0.3 + thr * 1.4 + Math.random() * 0.08);
    }
    sm.gear.visible = this.landed || this.autoLand || (this.mode === 'ship' && this.altitude < 90 && def.kind === 'rocky');
    // the white tail light breathes slowly and never goes out (no blinking); in comfort mode it stays under the bloom
    const breathe = 0.7 + 0.3 * Math.sin(this.time * 1.5);
    (sm.navLights[2].material as THREE.MeshBasicMaterial).color.setRGB(6, 6, 6).multiplyScalar(breathe * (this.lightsMode === 'comfort' ? 0.15 : 1));
    sm.headlight.intensity = this.lightsOn && this.mode === 'ship' ? 260 : 0;
    // reentry plasma
    let plasma = 0;
    if (this.mode === 'ship' && a && !this.warp && !this.hop) {
      const dens = Math.exp(-Math.max(0, this.altitude) / a.HR) * Math.min(3, a.surfaceDensity);
      const v = this.shipVel.length();
      plasma = clamp(dens * 40 * (v - 1500) / 4000, 0, 1.2);
    }
    // the glow of reentry swells and fades over a second or two (never on or off in one frame); dimmer in comfort mode
    this.plasmaI += (plasma - this.plasmaI) * (1 - Math.exp(-dt * 1.5));
    const pv = this.plasmaI * (this.lightsMode === 'comfort' ? 0.5 : 1);
    sm.plasma.visible = pv > 0.02;
    if (sm.plasma.visible) {
      this.plasmaMat.uniforms.uI.value = pv;
      this.plasmaMat.uniforms.uDir.value.copy(this.shipVel).normalize();
      this.plasmaMat.uniforms.uTime.value = this.time;
    }
    const as = this.astro;
    // vision mode: through the astronaut's own eyes (the body is hidden, its suit lamp still shines)
    as.root.visible = this.mode === 'foot';
    if (as.root.userData.hidden !== fpv) {
      as.root.userData.hidden = fpv;
      as.root.traverse((o) => { if ((o as THREE.Mesh).isMesh && !as.jet.includes(o as THREE.Mesh)) o.visible = !fpv; });
    }
    if (this.mode === 'foot') {
      const upP = this.playerPos.clone().sub(b.pos).normalize();
      as.root.position.copy(this.camOff).negate();
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
    // Light-speed look, pulse engine only (normal flight is untouched): every
    // star stays exactly in place, but the sky tints blue/brighter ahead and
    // red/dimmer behind, and the whole image takes a gentle blue colour grade
    // (a multiplication before tone mapping: hue shifts, nothing is hidden or
    // washed out). Everything eases in and out; nothing flashes.
    const vShip = this.mode === 'ship' ? this.shipVel.length() : 0;
    const dopTarget = this.warp && this.mode === 'ship' ? Math.min(0.85, 1 - Math.exp(-vShip / (0.5 * C_LIGHT))) : 0;
    this.dop += (dopTarget - this.dop) * Math.min(1, dt * 2);
    if (vShip > 1) this.dopDir.copy(this.shipVel).divideScalar(vShip);
    for (const m of [this.stars.material, this.milky.material] as THREE.ShaderMaterial[]) {
      m.uniforms.uDop.value = this.dop;
      m.uniforms.uVel.value.copy(this.dopDir);
    }
    const k = this.dop * (0.6 + 0.4 * this.glowFactor);
    (this.outputPass.material.uniforms as Record<string, THREE.IUniform>).heliosGrade.value.set(1 - 0.14 * k, 1 - 0.05 * k, 1 + 0.14 * k);
    const sMat = this.streaks.material as THREE.LineBasicMaterial;
    sMat.opacity += ((this.warp ? 0.15 * Math.max(0.2, wf) : 0) - sMat.opacity) * Math.min(1, dt * 2);
    this.streaks.visible = sMat.opacity > 0.01;
    if (this.streaks.visible) {
      const d = this.streakData;
      const out = (this.streaks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
      const vis = 500 + 1200 * wf;
      const len = 4 + 40 * wf;
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

  /**
   * Planets and moons as points of light (see makeGlints). Brightness from the real
   * photometry: albedo x Lambert phase x (R / distance)² / (distance to the star)²,
   * expressed as a magnitude against the full Moon (-12.7), then drawn with the same
   * magnitude -> brightness/size law as the catalogue stars. A disc big enough to see
   * gets an aureole instead when seen through an atmosphere (the Moon from Earth at
   * night); everything is dimmed and reddened by the air towards it and fades by day.
   */
  private updateGlints(starAlpha: number, inAir: boolean) {
    const g = this.glints.geometry;
    const pos = g.attributes.position as THREE.BufferAttribute, col = g.attributes.aColor as THREE.BufferAttribute;
    const size = g.attributes.aSize as THREE.BufferAttribute, halo = g.attributes.aHalo as THREE.BufferAttribute;
    const cw = this.camWorld, b = this.nearest;
    const rtH = this.composer.renderTarget1.height;
    const pxPerRad = rtH / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const pr = this.renderer.getPixelRatio();
    const F_MOON = 0.12 * (1737.4e3 / 384400e3) ** 2; // full Moon seen from Earth, magnitude -12.7
    const rel = new THREE.Vector3(), toStar = new THREE.Vector3(), tr = new THREE.Vector3(), c = new THREE.Color();
    this.bodies.forEach((body, i) => {
      size.setX(i, 0);
      if (body.def.kind === 'star' || body === b || !body.def.albedo || starAlpha <= 0.01) return;
      rel.copy(body.pos).sub(cw);
      const dist = rel.length();
      rel.divideScalar(dist);
      const pxR = (body.def.radius / dist) * pxPerRad;
      if (pxR > 40) return; // big on screen: the body itself is all there is to see
      toStar.copy(body.star.pos).sub(body.pos);
      const dStar = toStar.length();
      const alpha = Math.acos(clamp(-rel.dot(toStar) / dStar, -1, 1)); // phase angle
      const phase = (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI; // Lambert sphere
      const sAU = this.starAU(dStar);
      const F = (body.def.albedo * phase * (body.def.radius / dist) ** 2) / (sAU * sAU);
      if (F <= 0) return;
      const m = -12.74 - 2.5 * Math.log10(F / F_MOON);
      if (inAir) this.atmoTransmittance(b, rel, tr); else tr.set(1, 1, 1);
      c.set(body.def.markerColor);
      const lum = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b || 1;
      pos.setXYZ(i, rel.x, rel.y, rel.z);
      if (pxR < 1.2) {
        if (m > 7) return; // too faint for the naked eye
        const br = clamp(0.22 * Math.pow(10, -0.16 * (m - 6.5)), 0.08, 16) * starAlpha;
        const sz = 1.1 + 3.2 * Math.pow(clamp((6.5 - m) / 8, 0, 1), 1.3) + 2 * clamp((-1.5 - m) / 5, 0, 1);
        col.setXYZ(i, (c.r / lum) * br * tr.x, (c.g / lum) * br * tr.y, (c.b / lum) * br * tr.z);
        size.setX(i, sz * pr);
        halo.setX(i, 0);
      } else if (inAir) {
        // aureole: moonlight scattered forward by the air, a soft glow ~2° around the disc
        const k = Math.min(0.2, 0.12 * Math.sqrt(F / F_MOON)) * starAlpha * (0.6 + 0.4 * this.glowFactor);
        col.setXYZ(i, (c.r / lum) * k * tr.x, (c.g / lum) * k * tr.y, (c.b / lum) * k * tr.z);
        size.setX(i, Math.min(256, pxR * 36));
        halo.setX(i, 1);
      }
    });
    pos.needsUpdate = col.needsUpdate = size.needsUpdate = halo.needsUpdate = true;
  }

  /** Paint the gas giant that looks biggest, a strip per frame, once it is big on screen. */
  private updateGasBake() {
    let best: Body | null = null, bestAng = 0.05; // ~6° across: below that the live shader costs little
    for (const b of this.bodies) {
      if (!b.gasMat) continue;
      const ang = b.def.radius / Math.max(b.pos.distanceTo(this.camWorld), b.def.radius);
      if (ang > bestAng) { bestAng = ang; best = b; }
    }
    const gb = this.gasBaker;
    if (!best) return;
    if (gb.target !== best) {
      const prev = gb.target as Body | null;
      if (prev?.gasMat) prev.gasMat.uniforms.uBaked.value = 0;
      gb.start(best, best.def.gasType ?? 0);
    }
    if (!gb.ready && gb.advance(this.renderer)) {
      const u = best.gasMat!.uniforms;
      u.uBake.value = gb.rt.texture;
      u.uBakeSize.value = gb.size;
      u.uBaked.value = 1;
    }
  }

  private updateTerrain() {
    const cw = this.camWorld;
    // Zooming in (vision mode) counts as coming closer for other worlds: their terrain
    // detail loads as if the camera were nearer (a bit more than the zoom alone asks for,
    // so the Moon seen from Earth shows its craters and not just the seas).
    const zoomIn = this.vision ? Math.pow(this.camera.fov / VISION_FOV_MAX, 1.35) : 1;
    const sorted = this.bodies
      .filter((b) => b.terrain)
      .map((b) => {
        const z = b === this.nearest ? 1 : zoomIn;
        return { b, z, d: (cw.distanceTo(b.pos) / b.def.radius) * z };
      })
      .sort((x, y) => x.d - y.d);
    let first = true;
    for (const { b, d, z } of sorted) {
      const t = b.terrain!;
      if (d < 60) {
        const local = cw.clone().sub(b.pos).multiplyScalar(z);
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
    const w = this.cw, h = this.ch;
    const cw = this.camWorld;
    const v = new THREE.Vector3();
    const upd = this.frame % 6 === 0;
    // Bodies that project onto the same spot (a whole star system seen from
    // light-years away) would stack their labels: keep only the most relevant
    // one per spot: the destination, then stars, then the largest body.
    const placed: { x: number; y: number }[] = [];
    // "Behind the camera" must be decided geometrically: with a 1e17 m far plane
    // the projected depth of a body behind us rounds to exactly 1.0 in doubles,
    // so testing NDC z would draw mirrored ghost markers inside the view.
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const rank = (b: Body) => (b === this.target ? 2 : 0) + (b.def.kind === 'star' ? 1 : 0);
    const order = [...this.bodies].sort((a, b) => rank(b) - rank(a) || b.def.radius - a.def.radius);
    // pixels per radian at the centre of the view (to size the rings around bodies)
    const pxPerRad = h / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    for (const b of order) {
      // vision mode: nothing drawn over the sky
      if (this.vision) { css(b.marker, 'display', 'none'); continue; }
      v.copy(b.pos).sub(cw);
      const dist = v.length();
      const ang = b.def.radius / dist;
      const isT = this.target === b;
      const show = (ang < 0.05 || isT) && dist > b.def.radius * 1.5;
      if (!show) { css(b.marker, 'display', 'none'); continue; }
      const behind = v.dot(camFwd) <= 0;
      v.project(this.camera);
      let x = v.x, y = v.y;
      if (behind || Math.abs(x) > 1 || Math.abs(y) > 1) {
        if (!isT) { css(b.marker, 'display', 'none'); continue; }
        if (behind) { x = -x; y = -y; }
        const m = Math.max(Math.abs(x), Math.abs(y)) / 0.92;
        x /= m; y /= m;
      }
      const sx = (x * 0.5 + 0.5) * w, sy = (-y * 0.5 + 0.5) * h;
      if (!isT && placed.some((q) => Math.abs(q.x - sx) < 18 && Math.abs(q.y - sy) < 18)) { css(b.marker, 'display', 'none'); continue; }
      placed.push({ x: sx, y: sy });
      css(b.marker, 'display', 'block');
      css(b.marker, 'transform', `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`);
      css(b.marker, 'opacity', isT ? '1' : '0.7');
      // ring a little wider than the body's disc, so the body shows through it (the old
      // target marker was a filled diamond drawn right on top of the Moon)
      const ring = Math.round(clamp(2 * ang * pxPerRad + 12, 14, 90));
      const dot = b.marker.firstChild as HTMLDivElement;
      css(dot, 'width', `${ring}px`); css(dot, 'height', `${ring}px`);
      css(dot, 'borderWidth', isT ? '2px' : '1.5px');
      css(b.label, 'left', `${ring / 2 + 5}px`);
      if (upd) b.label.textContent = `${isT ? '◆ ' : ''}${b.def.name.toUpperCase()}  ${formatDist(dist - b.def.radius)}`;
    }
  }

  // -------------------------------------------------------------------------
  private loop = (t: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const raw = (t - this.lastT) / 1000;
    // (a frame timestamp can come before the last one measured: never a negative step)
    const dt = Math.max(0, Math.min(0.05, raw));
    this.lastT = t;
    // a long gap (a hidden tab, a hitch) says nothing about the frame rate
    if (raw > 0.25) this.qualityWin.t0 = 0;
    this.time += dt;
    this.frame++;
    // the display's own refresh rate: early on the title screen a few frames draw nothing and are timed
    const probing = this.hzProbe.n < 40 && this.frame > 20;
    if (probing) {
      const p = this.hzProbe;
      if (++p.n > 4 && raw > 0.002 && raw < 0.1) p.s.push(raw);
      if (p.n === 40 && p.s.length > 10) {
        p.s.sort((a, b) => a - b);
        this.refreshHz = clamp(1 / p.s[Math.floor(p.s.length / 2)], 24, 240);
      }
    }
    if (!this.locked && !this.touchMode) { this.mdx = 0; this.mdy = 0; }
    // zoomed in, the mouse turns the view proportionally slower (aiming at a crater, not a hill)
    if (this.vision && this.visionMode === 'eyes') { const z = this.camera.fov / VISION_FOV_MAX; this.mdx *= z; this.mdy *= z; }
    if (this.pressed.has('KeyO')) this.cycleVision();
    if (this.pressed.has('KeyP')) this.takePhoto();
    if (this.pressed.has('KeyN')) this.note(this.sfx.toggle() ? 'Sonido activado' : 'Sonido desactivado ({KeyN})');

    if (this.pressed.has('KeyF')) {
      if (!this.lightsOn && this.surv && this.mode === 'foot' && !this.surv.canLight()) this.note('Batería agotada: recárgala al sol o en la nave');
      else { this.lightsOn = !this.lightsOn; this.note(this.lightsOn ? 'Luces encendidas' : 'Luces apagadas'); }
    }
    if (this.pressed.has('KeyL')) {
      this.setLightsMode(this.lightsMode === 'comfort' ? 'bright' : 'comfort');
      this.note(this.lightsMode === 'comfort' ? 'Luces cómodas: brillos y resplandores atenuados' : 'Luces brillantes: aspecto original');
    }
    if (this.pressed.has('KeyG')) {
      this.setQuality((this.quality + 1) % QUALITY_LEVELS.length, true);
      this.note(`Calidad gráfica: ${QUALITY_LEVELS[this.quality].name}`);
    }
    if (!probing) this.qualityWatchdog(t);
    if (this.pressed.has('KeyT')) {
      const list = this.bodies;
      const i = this.target ? list.indexOf(this.target) : -1;
      this.setTarget(list[(i + 1) % list.length].def.id);
    }

    const focus = this.mode === 'ship' ? this.shipPos : this.playerPos;
    const star = this.nearestStar(focus);
    if (star !== this.sunBody) this.switchFrame(star);
    this.updateSystemPrep();
    this.nearest = this.findNearest(focus).body;
    if (!this.nearest.built) this.prepareSystem(this.nearest.star, true);
    const sv = this.surv;
    if (sv?.reading && (this.pressed.has('KeyR') || this.pressed.has('Enter') || this.pressed.has('Space'))) {
      sv.closeLog();
      this.pressed.clear(); // that key must not also jump or mine
    }
    // the world stands still behind the map, a recording, the death screen or the pause (Esc)
    const frozen = !!this.dead || this.menuOpen || !!sv?.reading || !!sv?.ending || !!sv?.intro || this.isPaused();
    if (!frozen) {
      this.simTime += dt;
      if (this.mode === 'ship') this.updateShip(dt);
      else this.updateFoot(dt);
      this.updateEnvironment(dt);
      sv?.update(dt);
      this.hurt = Math.max(0, this.hurt - dt * 0.9);
      if (!sv) this.exploreTick(dt);
    }
    this.updateSound(dt, frozen);
    this.nearest = this.findNearest(this.mode === 'ship' ? this.shipPos : this.playerPos).body;
    this.updateCamera(dt);
    this.updateTerrain();
    this.updateScene(dt);
    this.ruins.update();
    // the recordings' terminals stand in the story's squares in both modes (dim in exploration)
    this.ruins.updateTerminals(sv ? sv.logsRead : null, (site) => LOGS.find((l) => l.site === site)?.id);
    this.alien.update();
    sv?.render();
    this.updateGasBake();
    this.updateMarkers();
    this.updateWaypoint();
    // a paused game behind a window is drawn at a third of the rate (it looks the same under the veil)
    const veiled = this.started && frozen;
    if (veiled) this.qualityWin.t0 = 0;
    if (!probing && (!veiled || this.frame % 3 === 0 || this.photoPending)) {
      // the Sun's shadow map only while the Sun really lights the scene (at night its light is 0)
      this.renderer.shadowMap.needsUpdate = this.light.intensity > 0.01;
      this.composer.render();
      if (this.photoPending) { this.photoPending = false; this.savePhoto(); }
    }
    this.mdx = 0;
    this.mdy = 0;
    this.pressed.clear();
    this.notes = this.notes.filter((n) => this.simTime - n.t < 7);
  };

  /** every sound, both modes: music by place, the ambience, the fear only in survival */
  private updateSound(dt: number, frozen: boolean) {
    const sv = this.surv, b = this.nearest, def = b.def;
    const dark = 1 - clamp(this.light.intensity / 3.3 / 0.35, 0, 1);
    const tension = sv && !frozen ? sv.enemies.tension() : 0;
    const foot = this.mode === 'foot';
    const air = def.kind === 'gas' ? (this.altitude < 0 ? 1 : 0) : def.atmo ? Math.min(1, def.pressure) * Math.exp(-Math.max(0, this.altitude) / def.scaleHeight) : 0;
    const engine = this.mode === 'ship' && !this.landed ? (this.warp || this.hop ? 1 : clamp(Math.abs(this.throttle) + (this.keys.has('Space') || this.keys.has('KeyC') ? 0.3 : 0), 0, 1)) : 0;
    this.sfx.update(dt, { camQ: this.camera.quaternion, dark, tension, health: this.suit, onFoot: foot, explore: !sv, frozen, air, engine, jet: foot && this.astro.jet[0].visible });
    const mood: Mood = sv?.ending ? 'end' : frozen ? 'calm' : this.mode === 'ship' && this.altitude > 60e3 ? 'space' : dark > 0.6 ? (sv ? 'night' : 'calm') : 'ground';
    const key = (b.star.def.id === 'proxima' ? 5 : b.star.def.id === 'trappist-1' ? -6 : 0) + (WORLD_KEY[def.id] ?? 0);
    this.sfx.updateMusic(mood, tension, key);
  }

  /** exploration: the autosave, first visits to the ruins and the places of the signal, the grand tour */
  private exploreTick(dt: number) {
    this.exploreSaveT += dt;
    if (this.exploreSaveT > 60) { this.exploreSaveT = 0; this.saveExplore(); }
    if (this.frame % 15 !== 0) return;
    const p = this.mode === 'ship' ? this.shipPos : this.playerPos, b = this.nearest;
    if (b.def.id === 'earth' && !this.seen.has('ruins') && this.ruins.nearest(p, 4000)) {
      this.seen.add('ruins');
      this.persistSeen();
      this.note('Ruinas: en este universo la Tierra está en silencio. Su historia se cuenta en el modo Supervivencia');
    }
    for (const s of this.alien.sites) {
      if (s.body !== b.def.id || this.seen.has(s.id) || !b.terrain) continue;
      if (this.alien.centre(s, _v1).distanceTo(p) < 4000) {
        this.seen.add(s.id);
        this.persistSeen();
        this.note(`${s.name}: ${PLACE_INFO_EXPLORE[s.id] ?? ''}`);
      }
    }
    const done = (id: string) => {
      if (this.tour.has(id)) return;
      this.tour.add(id);
      try { localStorage.setItem(TOUR_KEY, JSON.stringify([...this.tour])); } catch { /* ignore */ }
      this.note(`Gran recorrido: ${GRAND_TOUR.find((x) => x.id === id)?.name ?? id} ✓ (${this.tour.size}/${GRAND_TOUR.length})`);
      this.sfx.play('chime');
    };
    const id = b.def.id;
    if (this.mode === 'foot' && (id === 'moon' || id === 'titan' || id === 'proxima-b' || id === 'trappist-1e')) done(id);
    if (id === 'jupiter' && this.altitude < 0) done('jupiter');
    if (id === 'mars') {
      const o = LANDMARKS[0];
      if (_v1.set(o.dir[0], o.dir[1], o.dir[2]).normalize().multiplyScalar(b.def.radius + 20e3).add(b.pos).distanceTo(p) < 60e3) done('olympus');
    }
    if (id === 'saturn') {
      const rel = _v1.copy(p).sub(b.pos), n = _v2.set(0, 1, 0).applyQuaternion(b.tiltQ);
      const hgt = Math.abs(rel.dot(n)), rr = Math.sqrt(Math.max(0, rel.lengthSq() - hgt * hgt));
      if (hgt < 1e6 && rr > b.def.radius * 1.11 && rr < b.def.radius * 2.3) done('rings');
    }
  }
  private persistSeen() { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...this.seen])); } catch { /* ignore */ } }

  /** a pulse jump to the destination, simulated with the engine's own rules: seconds and (survival) fuel */
  private jumpEst: { at: number; key: string; time: number; fuel: number | null } | null = null;
  jumpEstimate(): { time: number; fuel: number | null } | null {
    const tg = this.target;
    if (!tg) return null;
    const key = `${tg.def.id}:${this.warp}`;
    if (this.jumpEst && this.jumpEst.key === key && this.time - this.jumpEst.at < 0.5) return this.jumpEst;
    const p0 = this.mode === 'ship' ? this.shipPos : this.playerPos;
    const here = this.findNearest(p0);
    const da = this.dropAlt(tg);
    const D = Math.max(0, p0.distanceTo(tg.pos) - tg.def.radius - da);
    const sv = this.surv, fm = sv ? sv.mods().fuel : 1;
    let v = this.warp ? this.warpSpeed : Math.max(this.shipVel.length(), 8000);
    const startAlt = Math.max(here.alt, 1000);
    if (!this.warp && this.fastStart && here.alt > Math.max(here.body.def.radius * 20, 1e8)) v = Math.max(v, startAlt * 0.42 * 0.3);
    let s = 0, time = 0, n = 0, fuel = sv && !this.warp ? JUMP_COST * fm : 0;
    const step = 0.1;
    while (s < D && n++ < 6000) {
      const cap = Math.max(Math.min(startAlt + s, D - s + da), 1000) * 0.42;
      v = Math.min(v * Math.exp(step * 1.25), cap);
      s += v * step;
      time += step;
      if (sv) fuel += (0.25 + 0.12 * Math.max(0, Math.log10(v / 1e6))) * fm * step;
    }
    this.jumpEst = { at: this.time, key, time, fuel: sv ? fuel : null };
    return this.jumpEst;
  }
  /** the suborbital flight to the chosen point: possible here (K), or under way */
  private hopInfo(): HudState['hop'] {
    if (this.mode !== 'ship' || this.warp) return null;
    if (this.hop) return { possible: true, active: true, time: Math.max(0, this.hop.T - this.hop.t), fuel: null };
    const pt = this.waypoint ? this.placePoint(this.waypoint.id) : null;
    if (!pt || pt.b !== this.nearest || pt.b.def.kind !== 'rocky') return null;
    const dist = _v1.copy(this.shipPos).sub(pt.b.pos).normalize().angleTo(pt.dir) * pt.b.def.radius;
    if (dist < 1500) return null;
    return { possible: true, active: false, time: this.hopTime(dist), fuel: this.hopFuel(dist) };
  }
  private cardHud(): HudState['card'] {
    const c = this.card;
    if (!c) return null;
    const a = this.simTime - c.t;
    if (a > 10) { this.card = null; return null; }
    return { title: c.title, lines: c.lines, alpha: a < 1 ? a : a > 8.5 ? Math.max(0, (10 - a) / 1.5) : 1 };
  }

  getHud(): HudState {
    const b = this.nearest;
    const def = b.def;
    const p = this.mode === 'ship' ? this.shipPos : this.playerPos;
    let targetDist = 0;
    const jump = this.target ? this.jumpEstimate() : null;
    if (this.target) targetDist = p.distanceTo(this.target.pos) - this.target.def.radius;
    const touch = this.touchMode, kl = (c: string) => this.keyLabel(c);
    let hint = '';
    if (this.mode === 'ship') {
      if (this.hop) hint = `Vuelo suborbital · ${kl('KeyK')}: cancelar`;
      else if (this.landed) hint = touch ? 'BAJAR: salir de la nave · ▲ o empuje: despegar' : 'E: bajar de la nave · W / Espacio: despegar';
      else if (def.kind === 'rocky' && this.altitude < 60) hint = touch ? 'ATERRIZAR: posarse y bajar' : 'E: aterrizar y bajar';
      else if (def.kind === 'gas' && this.altitude < 200000) hint = 'Sin superficie: descender más aumentará la presión';
    } else if (this.playerPos.distanceTo(this.shipPos) < 14) hint = touch ? 'NAVE: subir a bordo' : 'E: subir a la nave';
    else if (!this.onGround && this.airTime > 20) hint = `${kl('KeyC')}: empujar hacia abajo · ${kl('KeyE')}: llamar a la nave`;
    else if (this.swimming) hint = 'Nadando: busca la orilla';
    const sunD = this.starAU(p.distanceTo(this.sunBody.pos));
    let hurtAngle: number | null = null;
    if (this.hurtDir && this.hurt > 0.02) {
      const v = _v1.copy(this.hurtDir).applyQuaternion(_q1.copy(this.camera.quaternion).invert());
      hurtAngle = (Math.atan2(v.x, -v.z) * 180) / Math.PI;
    }
    return {
      mode: this.mode,
      bodyId: def.id,
      bodyName: def.name,
      bodyKind: def.kind === 'gas' ? 'Gigante gaseoso' : def.kind === 'star' ? 'Estrella' : def.parent && this.byId.get(def.parent)?.def.kind !== 'star' ? 'Luna' : def.parent ? 'Exoplaneta rocoso' : 'Planeta rocoso',
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
      eta: jump?.time ?? 0,
      hint,
      warnings: this.warnings,
      notes: this.notes.map((n) => ({ id: n.id, text: n.text })),
      dead: this.dead,
      locked: this.locked,
      chunks: this.bodies.reduce((s, x) => s + (x.terrain?.chunkCount ?? 0), 0),
      landed: this.landed,
      lights: this.lightsOn,
      inCloud: this.inCloud,
      quality: QUALITY_LEVELS[this.quality].name + (this.qualityManual ? '' : ' (auto)'),
      autopilot: this.autopilot,
      lightsMode: this.lightsMode,
      fastStart: this.fastStart,
      vision: this.vision,
      zoom: VISION_FOV_MAX / this.camera.fov,
      gameMode: this.gameMode,
      survival: this.surv?.hud() ?? null,
      waypoint: this.waypoint ? { name: this.waypoint.name, dist: this.wpDist } : null,
      ruin: (() => {
        if (def.id !== 'earth') return null;
        const n = this.ruins.nearest(p, 150e3);
        return n ? { name: n.site.name, dist: n.dist } : null;
      })(),
      hurt: this.hurt,
      hurtAngle,
      paused: this.isPaused(),
      jump: this.mode === 'ship' && jump ? jump : null,
      hop: this.hopInfo(),
      swimming: this.swimming,
      card: this.cardHud(),
      visionMode: this.visionMode,
      sound: this.sfx.enabled,
      airborne: this.mode === 'foot' && !this.onGround && this.airTime > 1.5,
    };
  }

  dispose() {
    this.disposed = true;
    this.surv?.dispose();
    this.sfx.dispose();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.ruins.dispose();
    this.alien.dispose();
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('pointerlockerror', this.onLockError);
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.markerLayer.innerHTML = '';
  }
}

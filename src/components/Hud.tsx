import { memo, useEffect, useRef, useState } from 'react';
import type { Game, HudState } from '../game/Game';
import { formatDist, formatSpeed, QUALITY_LEVELS } from '../game/Game';
import { BODIES, C_LIGHT } from '../game/bodies';
import { LOGS, BASE_LOGS, FRAGMENTS, CACHES, UPGRADES, MEMENTOS, CRAFTS, GRAND_TOUR, WAKE_LINES, END_LINES, type LogEntry, type UpgradeId, type Place } from '../game/story';
import { LootSystem } from '../game/loot';

/** every recording of the story, in order (the pilot's own diaries last) */
const ALL_LOGS: LogEntry[] = [...LOGS, ...BASE_LOGS, ...FRAGMENTS, ...CACHES.flatMap((c) => (c.log ? [c.log] : []))];

const barColor = (v: number, ok: string) => (v > 50 ? ok : v > 25 ? '#fbbf24' : '#ef4444');

/** a bar: the fill is scaled (no layout work), it eases when it changes */
function Bar({ value, color, label, w = 'w-44', small = false }: { value: number; color: string; label: string; w?: string; small?: boolean }) {
  return (
    <div className={w}>
      <div className={`mb-1 flex justify-between ${small ? 'text-[11px]' : 'text-[10px]'} tracking-[0.2em] text-white/60`}>
        <span>{label}</span>
        <span>{value.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-full origin-left rounded-full transition-transform duration-200" style={{ transform: `scaleX(${Math.max(0, Math.min(100, value)) / 100})`, background: color }} />
      </div>
    </div>
  );
}

/** phones: a bar on one line (label, bar, value), so five of them fit above the stick */
function MiniBar({ value, color, label }: { value: number; color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] leading-none text-white/65">
      <span className="w-[58px] shrink-0 tracking-[0.08em]">{label}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-full origin-left rounded-full transition-transform duration-200" style={{ transform: `scaleX(${Math.max(0, Math.min(100, value)) / 100})`, background: color }} />
      </div>
      <span className="w-7 shrink-0 text-right">{value.toFixed(0)}</span>
    </div>
  );
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[3px]">
      <span className="text-[10px] uppercase tracking-[0.18em] text-white/45">{k}</span>
      <span className={`text-right text-[12px] ${accent ? 'text-amber-300' : 'text-white/90'}`}>{v}</span>
    </div>
  );
}

function fmtTime(s: number) {
  if (!isFinite(s) || s <= 0) return '—';
  if (s < 60) return `${s.toFixed(0)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  if (s < 86400 * 365.25 * 2) return `${(s / 86400).toFixed(1)} días`;
  return `${(s / (86400 * 365.25)).toFixed(2)} años`;
}
function fmtClock(s: number) {
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function fmtPressure(p: number) {
  if (p <= 0) return 'Vacío';
  if (p < 0.001) return `${(p * 1e6).toFixed(1)} µbar`;
  if (p < 0.1) return `${(p * 1000).toFixed(1)} mbar`;
  return `${p.toFixed(p < 10 ? 2 : 0)} bar`;
}

/** a soft one-time fade in (warnings appear, they never pulse) */
const STYLE = `@keyframes helios-in { from { opacity: 0 } to { opacity: 1 } }`;

/** A survivor's recording on screen (the game is paused). */
function LogReader({ log, onClose, touch }: { log: LogEntry; onClose: () => void; touch: boolean }) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-10 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className={`max-h-[90vh] w-[min(92vw,40rem)] overflow-y-auto rounded-2xl border border-amber-300/25 bg-black/80 ${touch ? 'p-4' : 'p-7'}`}>
        <div className="text-[10px] tracking-[0.45em] text-amber-300/80">{log.site === 'memento' ? 'RECUERDO' : 'REGISTRO RECUPERADO'}</div>
        <div className="mt-1 text-xl font-light tracking-[0.15em] text-white/95">{log.title}</div>
        <div className="mb-4 text-[11px] tracking-wider text-white/45">{log.from}</div>
        <div className={`space-y-3 ${touch ? 'text-[13px]' : 'text-sm'} leading-relaxed text-white/80`}>
          {log.text.map((t) => <p key={t}>{t}</p>)}
        </div>
        <button onClick={onClose} className="mt-6 rounded-lg border border-amber-300/40 bg-amber-300/10 px-6 py-2 text-xs tracking-[0.3em] text-amber-100 hover:bg-amber-300/20">
          CERRAR{touch ? '' : ' (R)'}
        </button>
      </div>
    </div>
  );
}

/** New survival game: the ship's computer wakes the pilot, line by line (soft fades, nothing flashes). */
function WakeIntro({ onDone }: { onDone: () => void }) {
  const [shown, setShown] = useState(0);
  const [leaving, setLeaving] = useState(false);
  // the HUD re-renders 10 times a second with a new callback: keep the timers independent of it
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (leaving) { const id = setTimeout(() => done.current(), 1400); return () => clearTimeout(id); }
    const id = setTimeout(() => (shown < WAKE_LINES.length ? setShown(shown + 1) : setLeaving(true)), shown === 0 ? 900 : shown < WAKE_LINES.length ? 1900 : 3200);
    return () => clearTimeout(id);
  }, [shown, leaving]);
  useEffect(() => {
    // any key or tap skips it
    const skip = () => setLeaving(true);
    const t = setTimeout(() => { window.addEventListener('keydown', skip); window.addEventListener('pointerdown', skip); }, 600);
    return () => { clearTimeout(t); window.removeEventListener('keydown', skip); window.removeEventListener('pointerdown', skip); };
  }, []);
  return (
    <div className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/85 transition-opacity duration-1000 ${leaving ? 'opacity-0' : 'opacity-100'}`}>
      <div className="w-[min(90vw,36rem)] space-y-3 font-mono">
        {WAKE_LINES.map((l, i) => (
          <div key={l} className={`transition-opacity duration-1000 ${i < shown ? 'opacity-100' : 'opacity-0'} ${i === 0 ? 'text-[11px] tracking-[0.5em] text-cyan-300/80' : 'text-sm text-white/80'}`}>{l}</div>
        ))}
        <div className="pt-4 text-[11px] tracking-[0.3em] text-white/30">toca o pulsa una tecla para saltar</div>
      </div>
    </div>
  );
}

/** The Spire falls silent: the last lines, soft fades, then the numbers of the journey. */
function EndSequence({ stats, onDone }: { stats: { time: number; deaths: number; logs: number; logsTotal: number; caches: number; cachesTotal: number; mementos: number; mementosTotal: number }; onDone: () => void }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown > END_LINES.length) return;
    const id = setTimeout(() => setShown(shown + 1), shown === 0 ? 1500 : 2600);
    return () => clearTimeout(id);
  }, [shown]);
  const m = Math.floor(stats.time / 60);
  return (
    <div className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center bg-black/90 font-mono">
      <div className="w-[min(90vw,38rem)] space-y-4 text-center">
        {END_LINES.map((l, i) => (
          <div key={l} className={`transition-opacity duration-[1500ms] ${i < shown ? 'opacity-100' : 'opacity-0'} ${i === 0 ? 'text-[12px] tracking-[0.6em] text-violet-300/80' : 'text-sm leading-relaxed text-white/80'}`}>{l}</div>
        ))}
        <div className={`pt-6 text-[11px] leading-6 tracking-[0.15em] text-white/50 transition-opacity duration-[1500ms] ${shown > END_LINES.length ? 'opacity-100' : 'opacity-0'}`}>
          <div>TIEMPO · {m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`}</div>
          <div>VECES QUE CAÍSTE · {stats.deaths}</div>
          <div>REGISTROS · {stats.logs}/{stats.logsTotal} · SECRETOS · {stats.caches}/{stats.cachesTotal}</div>
          <div>RECUERDOS · {stats.mementos}/{stats.mementosTotal}</div>
          <button onClick={onDone} className="mt-6 rounded-full border border-violet-200/30 bg-violet-200/10 px-8 py-2 text-xs tracking-[0.4em] text-violet-50 hover:bg-violet-200/20">SEGUIR EXPLORANDO</button>
        </div>
      </div>
    </div>
  );
}

/** The options: lights, quality, sound and its volumes, the jump's fast start (pause panel and the phone's gear). */
export function OptionsPanel({ game, onClose, touch }: { game: Game; onClose: () => void; touch: boolean }) {
  const [, redraw] = useState(0);
  const r = () => redraw((x) => x + 1);
  const sfx = game.sfx;
  const btn = 'rounded-md border border-white/20 px-3 py-1.5 text-[11px] tracking-[0.15em] text-white/85 hover:bg-white/10';
  return (
    <div className={`pointer-events-auto w-[min(92vw,26rem)] rounded-2xl border border-white/15 bg-black/85 ${touch ? 'p-4' : 'p-6'} font-mono text-white`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[11px] tracking-[0.4em] text-cyan-300/80">OPCIONES</div>
        <button onClick={onClose} className={btn}>CERRAR</button>
      </div>
      <div className="space-y-3 text-[12px]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-white/60">Luces</span>
          <button className={btn} onClick={() => { game.setLightsMode(game.lightsMode === 'comfort' ? 'bright' : 'comfort'); r(); }}>{game.lightsMode === 'comfort' ? 'CÓMODAS' : 'BRILLANTES'}</button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-white/60">Calidad gráfica</span>
          <button className={btn} onClick={() => { game.setQuality((game.quality + 1) % QUALITY_LEVELS.length, true); r(); }}>{QUALITY_LEVELS[game.quality].name.toUpperCase()}{game.qualityManual ? '' : ' (AUTO)'}</button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-white/60">Sonido</span>
          <button className={btn} onClick={() => { sfx.init(); sfx.toggle(); r(); }}>{sfx.enabled ? 'ACTIVADO' : 'APAGADO'}</button>
        </div>
        <label className="flex items-center justify-between gap-3">
          <span className="text-white/60">Música</span>
          <input type="range" min={0} max={100} value={Math.round(sfx.musicVol * 100)} onChange={(e) => { sfx.setVolumes(+e.target.value / 100, sfx.sfxVol); r(); }} className="w-40 accent-cyan-300" />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-white/60">Efectos</span>
          <input type="range" min={0} max={100} value={Math.round(sfx.sfxVol * 100)} onChange={(e) => { sfx.setVolumes(sfx.musicVol, +e.target.value / 100); r(); }} className="w-40 accent-cyan-300" />
        </label>
        <div className="flex items-center justify-between gap-3">
          <span className="text-white/60">Arranque rápido del salto</span>
          <button className={btn} onClick={() => { game.toggleFastStart(); r(); }}>{game.fastStart ? 'ACTIVADO' : 'APAGADO'}</button>
        </div>
      </div>
    </div>
  );
}

/** desktop: Esc freed the mouse and the game waits here */
function PausePanel({ game }: { game: Game }) {
  const [opts, setOpts] = useState(false);
  const btn = 'w-full rounded-lg border border-white/20 px-5 py-2.5 text-xs tracking-[0.35em] text-white/85 hover:bg-white/10';
  if (opts) return <div className="pointer-events-auto absolute inset-0 z-10 flex items-center justify-center bg-black/55"><OptionsPanel game={game} touch={false} onClose={() => setOpts(false)} /></div>;
  return (
    <div className="pointer-events-auto absolute inset-0 z-10 flex items-center justify-center bg-black/55" onClick={(e) => { if (e.target === e.currentTarget) game.requestLock(); }}>
      <div className="w-[min(90vw,20rem)] space-y-3 rounded-2xl border border-white/15 bg-black/80 p-6 text-center font-mono">
        <div className="mb-2 text-[11px] tracking-[0.5em] text-cyan-200/80">EN PAUSA</div>
        <button className={`${btn} border-cyan-300/40 bg-cyan-300/10 text-cyan-50`} onClick={() => game.requestLock()}>CONTINUAR</button>
        <button className={btn} onClick={() => game.toggleMenu(true)}>MAPA</button>
        <button className={btn} onClick={() => setOpts(true)}>OPCIONES</button>
        <button className={btn} onClick={() => { game.surv?.save(); game.saveExplore(); location.reload(); }}>GUARDAR Y SALIR</button>
        <div className="pt-1 text-[10px] tracking-[0.2em] text-white/35">o haz clic en la pantalla para seguir</div>
      </div>
    </div>
  );
}

/** the soft red edge of a hit: towards where it came from, or all around (a fall, no air) */
function HurtEdge({ s }: { s: HudState }) {
  // always there (opacity 0 when unhurt), so every change, the first one too, fades in
  const k = s.hurt < 0.02 ? 0 : Math.min(1, s.hurt) * (s.lightsMode === 'comfort' ? 0.55 : 0.8);
  const dir = s.hurtAngle !== null;
  const a = ((s.hurtAngle ?? 0) * Math.PI) / 180;
  const x = 50 + Math.sin(a) * 50, y = 50 - Math.cos(a) * 50;
  return (
    <div className="absolute inset-0 overflow-hidden transition-opacity duration-300" style={{ opacity: k }}>
      <div className="absolute inset-0 transition-opacity duration-300" style={{ opacity: dir ? 0 : 1, background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(120,10,10,0.55) 100%)' }} />
      <div className="absolute h-[70vmin] w-[70vmin] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-300" style={{ opacity: dir ? 1 : 0, left: `${x}%`, top: `${y}%`, background: 'radial-gradient(closest-side, rgba(140,12,12,0.6), rgba(140,12,12,0) 100%)' }} />
    </div>
  );
}

/** the help (desktop): memoised, it only changes with the mode */
const Help = memo(function Help({ mode, surv, fastStart, quality, lights, sound, open }: { mode: 'ship' | 'foot'; surv: boolean; fastStart: boolean; quality: string; lights: string; sound: boolean; open: boolean }) {
  return (
    <div className="mb-1">
      <div className="mb-1 flex justify-between text-[10px] tracking-[0.25em] text-white/50"><span>CONTROLES</span><span>H</span></div>
      {open && (mode === 'ship' ? (
        <div className="space-y-0.5">
          <div><b className="text-white">Ratón</b> cabeceo / guiñada</div>
          <div><b className="text-white">W / S</b> empuje · <b className="text-white">X</b> parar</div>
          <div><b className="text-white">A / D</b> alabeo · <b className="text-white">Shift</b> turbo</div>
          <div><b className="text-white">Espacio / C</b> subir / bajar (vertical)</div>
          <div><b className="text-white">J</b> salto luz (libre) · <b className="text-white">K</b> piloto automático</div>
          <div><b className="text-white">K</b> con un punto del mapa en este mundo: vuelo suborbital</div>
          {surv && <div className="text-orange-200/80">El salto gasta combustible: más cuanto más lejos</div>}
          {surv && <div><b className="text-white">Clic</b> cañones de la nave</div>}
          <div><b className="text-white">V</b> arranque rápido del pulso: {fastStart ? 'ON' : 'OFF'}</div>
          <div><b className="text-white">T / M</b> destino · mapa · <b className="text-white">Esc</b> pausa</div>
          <div><b className="text-white">E</b> aterrizar / bajar · <b className="text-white">F</b> luces</div>
          <div><b className="text-white">O</b> visión y modo foto · <b className="text-white">P</b> foto</div>
          <div><b className="text-white">G</b> calidad: {quality} · <b className="text-white">L</b> luces: {lights}</div>
          <div><b className="text-white">N</b> sonido: {sound ? 'ON' : 'OFF'}</div>
        </div>
      ) : (
        <div className="space-y-0.5">
          <div><b className="text-white">WASD</b> caminar · <b className="text-white">Shift</b> correr</div>
          <div><b className="text-white">Espacio</b> saltar (mantener: mochila) · <b className="text-white">C</b> mochila hacia abajo</div>
          <div><b className="text-white">Ratón</b> cámara · <b className="text-white">Rueda</b> zoom</div>
          <div><b className="text-white">E</b> subir a la nave · <b className="text-white">F</b> linterna</div>
          {surv && <div><b className="text-white">R</b> extraer (mantener) · escuchar · abrir</div>}
          {surv && <div><b className="text-white">Clic</b> disparar · <b className="text-white">1 / 2</b> arma · <b className="text-white">Q</b> esquivar</div>}
          {surv && <div><b className="text-white">B</b> botiquín · <b className="text-white">Z</b> baliza de luz</div>}
          <div><b className="text-white">O</b> visión y modo foto · <b className="text-white">P</b> foto · <b className="text-white">Esc</b> pausa</div>
          <div><b className="text-white">G</b> calidad: {quality} · <b className="text-white">L</b> luces: {lights}</div>
          <div><b className="text-white">N</b> sonido: {sound ? 'ON' : 'OFF'}</div>
        </div>
      ))}
    </div>
  );
});

export default function Hud({ game, onOpenMap, touch = false }: { game: Game; onOpenMap: () => void; touch?: boolean }) {
  const [s, setS] = useState<HudState | null>(null);
  const [help, setHelp] = useState(true);
  const [opts, setOpts] = useState(false);
  const [portrait, setPortrait] = useState(false);
  const [portraitOk, setPortraitOk] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setS(game.getHud()), 100);
    const k = (e: KeyboardEvent) => { if (e.code === 'KeyH' && !e.repeat) setHelp((h) => !h); };
    const o = () => setPortrait(window.innerHeight > window.innerWidth * 1.1);
    o();
    window.addEventListener('keydown', k);
    window.addEventListener('resize', o);
    return () => { clearInterval(id); window.removeEventListener('keydown', k); window.removeEventListener('resize', o); };
  }, [game]);
  // vision mode: its hint shows for a few seconds after entering, then fades away
  const vision = !!s?.vision;
  const vmode = s?.visionMode;
  const [visionHint, setVisionHint] = useState(false);
  useEffect(() => {
    if (!vision) return;
    setVisionHint(true);
    const id = setTimeout(() => setVisionHint(false), 3500);
    return () => clearTimeout(id);
  }, [vision, vmode]);
  if (!s) return null;
  // vision mode: nothing over the sky but that hint and the zoom factor
  if (s.vision && !s.dead && !s.survival?.reading && !s.survival?.intro && !s.survival?.ending && !s.paused) {
    const ext = s.visionMode === 'exterior';
    return (
      <div className="pointer-events-none absolute inset-0 select-none font-mono text-white">
        <div className={`absolute bottom-5 left-1/2 -translate-x-1/2 text-center text-[11px] tracking-[0.3em] text-white/45 transition-opacity duration-1000 ${visionHint ? 'opacity-100' : 'opacity-0'}`}>
          {ext ? 'MODO FOTO' : 'MODO VISIÓN'} · {touch ? (ext ? 'FOTO para guardar · SALIR para volver' : 'EXTERIOR: cámara de fuera · + / − zoom') : ext ? 'P: guardar foto · O: salir' : 'O: modo foto · rueda: zoom · P: foto'}
        </div>
        {s.zoom > 1.05 && !ext && <div className="absolute right-5 top-5 text-xs tracking-[0.2em] text-white/45">×{s.zoom.toFixed(s.zoom < 10 ? 1 : 0)}</div>}
        {s.notes.length > 0 && s.notes[s.notes.length - 1].text.startsWith('Foto guardada') && (
          <div className="absolute left-1/2 top-5 -translate-x-1/2 rounded bg-black/40 px-3 py-1 text-[11px] text-white/60">{s.notes[s.notes.length - 1].text}</div>
        )}
      </div>
    );
  }
  const sv = s.survival;
  const isGas = s.bodyKind === 'Gigante gaseoso';
  const altLabel = isGas ? (s.altitude < 0 ? 'Profundidad' : 'Sobre nubes') : 'Altitud';
  const altVal = isGas && s.altitude < 0 ? formatDist(-s.altitude) : formatDist(s.altitude);
  const c = s.speed / C_LIGHT;
  // glass panels blur what is behind them: lovely, but costly on phones and on the lowest qualities
  const light = touch || s.quality.startsWith('Básica') || s.quality.startsWith('Móvil');
  const glass = light ? 'bg-black/55' : 'bg-black/35 backdrop-blur-md';
  const kl = (code: string) => game.keyLabel(code);
  const modeText = s.mode === 'ship' ? (s.warp ? (sv?.emergency ? 'EMERGENCIA' : 'PULSO') : s.hop?.active ? 'SUBORBITAL' : s.landed ? (s.swimming ? 'A FLOTE' : 'ATERRIZADO') : 'VUELO') : s.swimming ? 'NADANDO' : 'A PIE';
  const jumpFuel = sv && s.jump && s.jump.fuel !== null ? s.jump.fuel : null;
  const enough = jumpFuel === null || !sv || jumpFuel <= sv.fuel;

  const vegaBox = sv?.vega && (
    <div className={`${touch ? 'w-[min(62vw,26rem)]' : 'w-[min(90vw,40rem)]'} text-center`} style={{ opacity: sv.vega.alpha }}>
      <span className={`rounded-lg px-3 py-1.5 ${touch ? 'text-[12px]' : 'text-[13px]'} leading-relaxed text-cyan-50/90 ${light ? 'bg-black/60' : 'bg-black/45 backdrop-blur'}`}>
        <b className="mr-2 text-[10px] tracking-[0.3em] text-cyan-300/80">VEGA</b>{sv.vega.text.slice(0, sv.vega.chars)}
      </span>
    </div>
  );
  const hintBox = s.hint && (
    <div className={`rounded-lg border border-white/15 px-4 py-2 ${touch ? 'text-[12px]' : 'text-sm'} tracking-wider text-white/90 ${light ? 'bg-black/55' : 'bg-black/40 backdrop-blur'}`}>{s.hint}</div>
  );
  const topLane = (
    <>
      {s.warnings.map((w) => (
        // a steady box that fades in once (never pulses)
        <div key={w.replace(/[\d.]+/g, '#')} className={`rounded border-2 border-red-500/60 bg-red-950/55 px-4 py-1 ${touch ? 'text-[12px]' : 'text-sm'} tracking-[0.25em] text-red-200`} style={{ animation: 'helios-in 0.6s ease-out' }}>⚠ {w}</div>
      ))}
      {sv?.boss && (
        <div className="w-[min(80vw,26rem)] text-center">
          <div className="text-[10px] tracking-[0.5em] text-violet-200/90">EL GUARDIÁN</div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-full origin-left rounded-full bg-violet-300/80 transition-transform duration-300" style={{ transform: `scaleX(${sv.boss.hp})` }} />
          </div>
          {sv.boss.pylons > 0 && <div className="mt-1 text-[11px] tracking-[0.2em] text-violet-200/60">ESCUDO ACTIVO · destruye los pilones ({sv.boss.pylons})</div>}
          {sv.boss.exposed && <div className="mt-1 text-[11px] tracking-[0.25em] text-violet-100/90">EL CORAZÓN ESTÁ AL DESCUBIERTO</div>}
        </div>
      )}
      {sv?.translate && (
        <div className="w-56 text-center">
          <div className="text-[11px] tracking-[0.2em] text-teal-100/85">{sv.translate.near ? 'TRADUCIENDO LA INSCRIPCIÓN…' : 'ACÉRCATE A LA PIEDRA PARA SEGUIR'}</div>
          <div className="mx-auto mt-1 h-1 w-48 overflow-hidden rounded-full bg-white/15">
            <div className="h-full w-full origin-left rounded-full bg-teal-200/80" style={{ transform: `scaleX(${sv.translate.k})` }} />
          </div>
        </div>
      )}
    </>
  );

  // the first visit to a world (exploration): a soft card with a few real facts
  const card = s.card && (
    <div className="absolute left-1/2 top-[18%] w-[min(88vw,28rem)] -translate-x-1/2 rounded-xl border border-cyan-200/15 bg-black/50 px-5 py-3 text-center" style={{ opacity: s.card.alpha }}>
      <div className="text-[10px] tracking-[0.4em] text-cyan-300/70">PRIMERA VISITA</div>
      <div className="mt-1 text-lg font-light tracking-[0.2em]">{s.card.title}</div>
      {s.card.lines.map((l) => <div key={l} className="mt-1 text-[12px] text-white/70">{l}</div>)}
    </div>
  );

  const deathScreen = s.dead && (
    <div className="pointer-events-auto absolute inset-0 z-10 flex items-center justify-center bg-black/75">
      <div className="max-w-xl rounded-2xl border border-red-500/30 bg-black/70 p-8 text-center">
        <div className="mb-2 text-[11px] tracking-[0.5em] text-red-400">SEÑAL PERDIDA</div>
        <div className="mb-6 text-lg font-light leading-relaxed text-white/90">{s.dead}</div>
        {sv?.deathNote && <div className="mb-6 text-sm leading-relaxed text-white/60">{sv.deathNote}</div>}
        <button
          onClick={() => { game.revive(); setTimeout(() => game.requestLock(), 50); }}
          className="rounded-lg border border-cyan-300/40 bg-cyan-300/10 px-6 py-2 tracking-[0.3em] text-cyan-100 hover:bg-cyan-300/20"
        >
          {sv ? (s.mode === 'foot' ? 'DESPERTAR EN LA NAVE' : 'RECONSTRUIR LA NAVE') : 'REAPARECER'}
        </button>
      </div>
    </div>
  );

  const overlays = (
    <>
      <HurtEdge s={s} />
      {sv?.reading && <LogReader log={sv.reading} touch={touch} onClose={() => game.surv?.closeLog()} />}
      {sv?.intro && <WakeIntro onDone={() => game.surv?.finishIntro()} />}
      {sv?.ending && <EndSequence stats={sv.stats} onDone={() => game.surv?.finishEnding()} />}
      {deathScreen}
      {s.paused && !touch && <PausePanel game={game} />}
      {opts && touch && <div className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center bg-black/55"><OptionsPanel game={game} touch onClose={() => setOpts(false)} /></div>}
      {touch && portrait && !portraitOk && (
        <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/80 p-6 text-center">
          <div>
            <div className="text-sm tracking-[0.2em] text-white/85">Gira el teléfono</div>
            <div className="mt-2 text-[12px] text-white/55">HELIOS se juega en horizontal.</div>
            <button onClick={() => setPortraitOk(true)} className="mt-4 rounded-md border border-white/20 px-4 py-1.5 text-[11px] tracking-[0.2em] text-white/70">SEGUIR ASÍ</button>
          </div>
        </div>
      )}
    </>
  );

  const crosshair = (
    <>
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="h-1 w-1 rounded-full bg-white/70 shadow-[0_0_6px_rgba(255,255,255,0.8)]" />
      </div>
      {/* survival: a hit landed (a soft × that fades, never blinks) and the target's strength left */}
      {sv && sv.hitT < 0.4 && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-lg leading-none text-white/80" style={{ opacity: 1 - sv.hitT / 0.4 }}>×</div>
      )}
      {sv && sv.hitT < 1.6 && sv.hitHp > 0 && (
        <div className="absolute left-1/2 top-1/2 mt-4 h-[3px] w-12 -translate-x-1/2 overflow-hidden rounded-full bg-white/15" style={{ opacity: 1 - sv.hitT / 1.6 }}>
          <div className="h-full w-full origin-left bg-red-300/80" style={{ transform: `scaleX(${sv.hitHp})` }} />
        </div>
      )}
      {/* what R (USAR) does here, and the extraction in progress, above the crosshair */}
      {sv && s.mode === 'foot' && sv.prompt && (
        <div className="absolute left-1/2 top-[38%] -translate-x-1/2 text-center text-[12px] tracking-[0.2em] text-amber-200/90">{touch ? '▸ ' : `${kl('KeyR')}: `}{sv.prompt}</div>
      )}
      {sv && s.mode === 'foot' && sv.near && !sv.nearLog && (
        <div className="absolute left-1/2 top-[38%] w-60 -translate-x-1/2 text-center">
          <div className="text-[12px] tracking-[0.2em] text-white/85">{touch ? 'MINAR' : 'R'} (mantener): extraer {sv.near}</div>
          <div className="mx-auto mt-1 h-1 w-40 overflow-hidden rounded-full bg-white/15">
            <div className="h-full w-full origin-left rounded-full bg-cyan-200/80" style={{ transform: `scaleX(${sv.mining})` }} />
          </div>
        </div>
      )}
    </>
  );

  const objective = sv && (
    <>
      <div className="text-[10px] tracking-[0.3em] text-amber-300/80">OBJETIVO</div>
      <div className="mt-1 text-[12px] leading-snug text-white/85">{sv.objective}</div>
      {sv.objectiveDist !== null && <div className="mt-1 text-[11px] text-amber-200/70">◆ {formatDist(sv.objectiveDist)}</div>}
      {sv.scanner && (
        <div className="mt-2 flex items-center gap-2 text-[10px] tracking-[0.2em] text-teal-200/70">
          <span>ESCÁNER</span>
          {sv.scan ? (
            <>
              <span className="inline-block" style={{ transform: `rotate(${sv.scan.angle.toFixed(0)}deg)` }}>↑</span>
              <span>señal escondida · {formatDist(sv.scan.dist)}</span>
            </>
          ) : <span className="text-white/35">sin señales cerca</span>}
        </div>
      )}
    </>
  );
  const jumpLine = s.targetName && s.mode === 'ship' && s.jump && (
    <div className={`text-[11px] ${enough ? 'text-amber-200/80' : 'text-orange-300'}`}>
      Salto ≈ {fmtTime(s.jump.time)}{jumpFuel !== null && sv ? ` · combustible ≈ ${Math.ceil(jumpFuel)}% (tienes ${Math.floor(sv.fuel)}%)` : ''}
    </div>
  );
  const hopLine = s.hop && (
    <div className="text-[11px] text-cyan-200/80">
      {s.hop.active ? `Vuelo suborbital · llegada en ${fmtTime(s.hop.time)}` : `${kl('KeyK')}: vuelo suborbital · ≈ ${fmtTime(s.hop.time)}${s.hop.fuel !== null ? ` · combustible ${s.hop.fuel.toFixed(0)}%` : ''}`}
    </div>
  );

  // -----------------------------------------------------------------------
  // phones: a layout of its own (thin bars in a corner, one-line objective, room for the thumbs)
  if (touch) {
    return (
      <div className="pointer-events-none absolute inset-0 select-none font-mono text-white" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <style>{STYLE}</style>
        {crosshair}
        {/* top left: where you are */}
        <div className="absolute left-3 top-3 max-w-[38vw] rounded-lg bg-black/45 px-3 py-1.5">
          <div className="text-[11px] tracking-[0.2em] text-cyan-200/80">{s.bodyName.toUpperCase()}</div>
          <div className="text-[11px] text-white/75">{altLabel} {altVal} · {formatSpeed(s.speed)}</div>
          {s.ruin && <div className="text-[11px] text-white/55">Ruinas: {s.ruin.name} · {formatDist(s.ruin.dist)}</div>}
        </div>
        {/* top centre: objective or destination on one or two lines, then the message lane */}
        <div className="absolute left-1/2 top-3 flex w-[min(46vw,26rem)] -translate-x-1/2 flex-col items-center gap-1 text-center">
          {sv ? (
            <div className="rounded-lg bg-black/45 px-3 py-1 text-[11px] leading-snug text-amber-100/90">◆ {sv.objective}{sv.objectiveDist !== null ? ` · ${formatDist(sv.objectiveDist)}` : ''}</div>
          ) : s.targetName && <div className="rounded-lg bg-black/45 px-3 py-1 text-[11px] text-amber-100/90">◆ {s.targetName} · {formatDist(s.targetDist)}</div>}
          {s.waypoint && <div className="rounded-lg bg-black/40 px-3 py-0.5 text-[11px] text-cyan-200/85">○ {s.waypoint.name}{s.waypoint.dist !== null ? ` · ${formatDist(s.waypoint.dist)}` : ''}</div>}
          {sv?.scan && <div className="text-[11px] text-teal-200/80"><span className="inline-block" style={{ transform: `rotate(${sv.scan.angle.toFixed(0)}deg)` }}>↑</span> señal escondida · {formatDist(sv.scan.dist)}</div>}
          {topLane}
          {hintBox}
          {vegaBox}
          {(jumpLine || hopLine) && <div className="rounded bg-black/40 px-2 py-0.5">{jumpLine}{hopLine}</div>}
        </div>
        {/* top right: options (sound, lights, quality) */}
        <button onClick={() => setOpts(true)} className="pointer-events-auto absolute right-3 top-3 h-10 w-10 rounded-full border border-white/25 bg-black/40 text-lg text-white/80 active:bg-white/20" aria-label="Opciones">⚙</button>
        {/* left: thin one-line bars, between the place panel and the stick */}
        <div className="absolute left-3 top-[64px] w-40 space-y-1.5 rounded-lg bg-black/40 px-2.5 py-2">
          {s.mode === 'ship' ? (
            <>
              <MiniBar label="CASCO" value={s.hull} color={barColor(s.hull, '#7dd3fc')} />
              {sv && <MiniBar label="COMBUST." value={sv.fuel} color={barColor(sv.fuel, '#fb923c')} />}
              <MiniBar label="EMPUJE" value={Math.max(0, s.throttle) * 100} color="#a78bfa" />
            </>
          ) : (
            <>
              <MiniBar label={sv ? 'SALUD' : 'TRAJE'} value={s.suit} color={barColor(s.suit, '#86efac')} />
              {sv?.healthCause && <div className="text-[10px] leading-tight text-rose-200/70">{sv.healthCause}</div>}
              {sv && <MiniBar label="OXÍGENO" value={sv.oxygen} color={barColor(sv.oxygen, '#e0f2fe')} />}
              {sv && <MiniBar label="ENERGÍA" value={sv.energy} color={barColor(sv.energy, '#fde68a')} />}
              <MiniBar label="MOCHILA" value={s.fuel} color="#7dd3fc" />
            </>
          )}
          <div className="text-[11px] tracking-[0.15em] text-white/60">{modeText}{s.lights ? ' · LUZ' : ''}</div>
          {sv && s.mode === 'foot' && <div className="text-[10px] text-white/50">CARGA {sv.carried.ice + sv.carried.metal + sv.carried.crystal}/{sv.cap} · ✚{sv.medkits}{sv.beacons ? ` · ✦${sv.beacons}` : ''}</div>}
          {sv && s.mode === 'ship' && <div className="text-[10px] text-white/50">BODEGA {sv.stored.ice}h · {sv.stored.metal}m · {sv.stored.crystal}c</div>}
          {sv?.refining && <div className="text-[10px] text-orange-200/80">{sv.refining}</div>}
          {sv && <div className={`text-[10px] tracking-[0.2em] text-white/45 transition-opacity duration-700 ${sv.saved ? 'opacity-100' : 'opacity-0'}`}>✓ GUARDADO</div>}
        </div>
        {/* notes: in the free band right of the stick, left of the buttons */}
        <div className="absolute bottom-3 left-[156px] w-[min(40vw,19rem)] space-y-1">
          {s.notes.map((n) => <div key={n.id} className="rounded-md border-l-2 border-cyan-300/70 bg-black/55 px-2 py-1 text-[11px] text-white/90">{n.text}</div>)}
        </div>
        {card}
        {overlays}
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // desktop
  return (
    <div className="pointer-events-none absolute inset-0 select-none font-mono text-white">
      <style>{STYLE}</style>
      {crosshair}

      {/* location panel */}
      <div className={`absolute left-5 top-5 w-72 rounded-xl border border-white/10 p-4 ${glass}`}>
        <div className="text-[10px] tracking-[0.3em] text-cyan-300/80">{s.bodyKind.toUpperCase()}</div>
        <div className="mb-2 text-2xl font-light tracking-wider">{s.bodyName}</div>
        <Row k={altLabel} v={altVal} accent={isGas && s.altitude < 0} />
        {s.ruin && <Row k="Ruinas" v={`${s.ruin.name} · ${formatDist(s.ruin.dist)}`} />}
        <Row k="Gravedad" v={`${s.gravity} m/s² · ${(s.gravity / 9.81).toFixed(2)} g`} />
        <Row k="Presión" v={fmtPressure(s.pressure)} accent={s.pressure > 20} />
        <Row k="Temperatura" v={(isGas && s.altitude < 0) || s.bodyKind === 'Estrella' ? `${s.tempValue.toFixed(0)} °C` : s.temperature} />
        <Row k="Luz solar" v={`${(s.sunlight * 100).toFixed(s.sunlight < 0.1 ? 2 : 0)}% de la Tierra`} />
        <div className="mt-2 border-t border-white/10 pt-2 text-[11px] leading-relaxed text-white/60">{s.composition}</div>
      </div>

      {/* target panel */}
      <div className={`absolute right-5 top-5 w-64 rounded-xl border border-white/10 p-4 ${glass}`}>
        {sv && <div className="mb-3 border-b border-white/10 pb-3">{objective}</div>}
        <div className="text-[10px] tracking-[0.3em] text-amber-300/80">DESTINO</div>
        {s.waypoint && (
          <div className="mt-1 text-[11px] text-cyan-200/80">○ {s.waypoint.name}{s.waypoint.dist !== null ? ` · ${formatDist(s.waypoint.dist)}` : ''}</div>
        )}
        {s.targetName ? (
          <>
            <div className="mb-2 text-xl font-light tracking-wider">{s.targetName}</div>
            <Row k="Distancia" v={formatDist(s.targetDist)} />
            <Row k="Luz tarda" v={fmtTime(s.targetDist / C_LIGHT)} />
            {jumpLine}
          </>
        ) : (
          <div className="py-2 text-sm text-white/50">Sin destino</div>
        )}
        {hopLine}
        <div className="mt-3 flex gap-2 text-[10px] text-white/50">
          <span className="rounded border border-white/20 px-1.5">T</span> siguiente
          <span className="ml-2 rounded border border-white/20 px-1.5">M</span> mapa
        </div>
        <div className="mt-2 text-[10px] text-white/50">
          <span className="rounded border border-white/20 px-1.5">K</span> piloto automático:{' '}
          <span className={s.autopilot ? 'text-amber-200' : 'text-white/40'}>{s.autopilot ? 'ON' : 'OFF · salto libre'}</span>
        </div>
        <button onClick={onOpenMap} className="pointer-events-auto mt-3 w-full rounded-md border border-amber-300/30 bg-amber-300/10 py-1.5 text-[11px] tracking-[0.2em] text-amber-200 hover:bg-amber-300/20">
          MAPA DEL SISTEMA
        </button>
      </div>

      {/* top lane: warp banner, then the warnings, the Guardian, the translation, one under another */}
      <div className="absolute left-1/2 top-6 flex -translate-x-1/2 flex-col items-center gap-1.5 text-center">
        {s.warp && (
          <div className="mb-1">
            <div className="text-[11px] tracking-[0.5em] text-cyan-200/90">MOTOR DE PULSO ACTIVO</div>
            <div className="text-3xl font-extralight tracking-widest text-cyan-100 drop-shadow-[0_0_12px_rgba(120,200,255,0.8)]">{c >= 1 ? `${c.toFixed(c > 100 ? 0 : 1)} × c` : formatSpeed(s.speed)}</div>
          </div>
        )}
        {!s.warp && <div className="h-10" />}
        {topLane}
      </div>
      {card}

      {/* bottom lane: VEGA, the hint, then the flight data; stacked, so they never overlap */}
      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
        {vegaBox}
        {hintBox}
        <div className={`flex items-end gap-8 rounded-2xl border border-white/10 px-7 py-4 ${glass}`}>
          <div className="text-center">
            <div className="text-[10px] tracking-[0.3em] text-white/50">VELOCIDAD</div>
            <div className="min-w-[150px] text-3xl font-extralight tracking-wider">{formatSpeed(s.speed)}</div>
            {s.mode === 'ship' && c > 0.0005 && <div className="text-[10px] text-cyan-300/80">{(c * 100).toFixed(c < 0.01 ? 3 : 1)}% velocidad de la luz</div>}
            {s.mode === 'ship' && c > 0.1 && c < 1 && (
              <div className="text-[10px] text-cyan-200/60">dilatación temporal γ = {(1 / Math.sqrt(1 - c * c)).toFixed(2)} · 1 s a bordo = {(1 / Math.sqrt(1 - c * c)).toFixed(2)} s fuera</div>
            )}
          </div>
          {s.mode === 'ship' ? (
            <div className="flex flex-col gap-2">
              <Bar key="CASCO" label="CASCO" value={s.hull} color={barColor(s.hull, '#7dd3fc')} />
              {sv && <Bar key="COMBUSTIBLE" label="COMBUSTIBLE" value={sv.fuel} color={barColor(sv.fuel, '#fb923c')} />}
              <Bar key="EMPUJE" label="EMPUJE" value={Math.max(0, s.throttle) * 100} color="#a78bfa" />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Bar key={sv ? 'SALUD' : 'TRAJE'} label={sv ? 'SALUD' : 'TRAJE'} value={s.suit} color={barColor(s.suit, '#86efac')} />
              {sv?.healthCause && <div className="-mt-1 w-44 text-[10px] leading-tight text-rose-200/70">{sv.healthCause}</div>}
              {sv && <Bar key="OXÍGENO" label="OXÍGENO" value={sv.oxygen} color={barColor(sv.oxygen, '#e0f2fe')} />}
              {sv && <Bar key="ENERGÍA" label="ENERGÍA" value={sv.energy} color={barColor(sv.energy, '#fde68a')} />}
              <Bar key="JETPACK" label="MOCHILA" value={s.fuel} color="#7dd3fc" />
            </div>
          )}
          <div className="text-center">
            <div className="text-[10px] tracking-[0.3em] text-white/50">MODO</div>
            <div className="text-sm tracking-widest text-white/85">{modeText}</div>
            <div className="mt-1 text-[10px] text-white/40">{s.lights ? 'LUCES ON' : 'LUCES OFF'}</div>
            {s.airborne && <div className="text-[10px] text-cyan-200/60">C: mochila hacia abajo</div>}
            {sv && (s.mode === 'foot' ? (
              <div className="mt-2 text-[10px] tracking-[0.15em] text-white/60">CARGA {sv.carried.ice + sv.carried.metal + sv.carried.crystal}/{sv.cap}<div className="text-white/40">{sv.carried.ice} hielo · {sv.carried.metal} metal{sv.carried.crystal ? ` · ${sv.carried.crystal} cristal` : ''}</div><div className="mt-1 text-cyan-200/60">{sv.weapon === 'dispersor' ? 'DISPERSOR' : 'FUSIL'} · {sv.shotCost}%{sv.dispersor ? ' · 1/2' : ''}</div><div className="text-rose-200/60">BOTIQUINES {sv.medkits} · B</div>{(sv.beacons > 0 || sv.beaconLeft !== null) && <div className="text-amber-200/60">BALIZAS {sv.beacons} · Z{sv.beaconLeft !== null ? ` · ${fmtClock(sv.beaconLeft)}` : ''}</div>}</div>
            ) : (
              <div className="mt-2 text-[10px] tracking-[0.15em] text-white/60">BODEGA<div className="text-white/40">{sv.stored.ice} hielo · {sv.stored.metal} metal</div><div className="text-violet-200/50">{sv.stored.crystal} cristal</div></div>
            ))}
            {sv?.refining && <div className="mt-1 text-[10px] text-orange-200/80">{sv.refining}</div>}
            {sv && <div className={`mt-1 text-[9px] tracking-[0.2em] text-white/45 transition-opacity duration-700 ${sv.saved ? 'opacity-100' : 'opacity-0'}`}>✓ GUARDADO</div>}
          </div>
        </div>
      </div>

      {/* notifications */}
      <div className="absolute bottom-6 left-5 w-96 space-y-1.5">
        {s.notes.map((n) => (
          <div key={n.id} className={`rounded-md border-l-2 border-cyan-300/70 px-3 py-1.5 text-[12px] text-white/90 ${light ? 'bg-black/60' : 'bg-black/45 backdrop-blur'}`}>{n.text}</div>
        ))}
      </div>

      {/* help */}
      <div className={`absolute bottom-6 right-5 w-64 rounded-xl border border-white/10 p-3 text-[11px] text-white/70 ${glass}`}>
        <Help mode={s.mode} surv={!!sv} fastStart={s.fastStart} quality={s.quality} lights={s.lightsMode === 'comfort' ? 'cómodas' : 'brillantes'} sound={s.sound} open={help} />
      </div>

      {overlays}
    </div>
  );
}

/** The map's list of places: mission points (survival) or real places, ruins and alien places (exploration). */
function PlacesTab({ game, places, sel, onSel, onGo, touch }: { game: Game; places: Place[]; sel: string | null; onSel: (id: string) => void; onGo: (id: string) => void; touch: boolean }) {
  const cur = places.find((p) => p.id === sel) ?? places.find((p) => p.status === 'objetivo') ?? places[0];
  const label = { hecho: '✓ HECHO', objetivo: '◆ OBJETIVO ACTUAL', pendiente: 'PENDIENTE' } as const;
  const tone = { hecho: 'text-white/40', objetivo: 'text-amber-200', pendiente: 'text-cyan-200/70' } as const;
  const sv = game.surv;
  // grouped: the real places first, then by star system and world, in the order they come
  const groups: { key: string; title: string; items: Place[] }[] = [];
  for (const p of places) {
    const key = p.real ? 'real' : p.optional ? 'optional' : `${p.system}/${p.world}`;
    let gr = groups.find((x) => x.key === key);
    if (!gr) groups.push((gr = { key, title: p.real ? 'Lugares reales' : p.optional ? 'Opcional' : p.system === p.world || p.system === 'Sol' ? p.world : `${p.world} · ${p.system}`, items: [] }));
    gr.items.push(p);
  }
  const towns = game.ruins.sites.filter((x) => x.id.startsWith('town-'));
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className={`flex-1 overflow-y-auto ${touch ? 'p-3' : 'p-8'}`}>
      {note && <div className="mb-2 text-xs text-amber-200/80">{note}</div>}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] tracking-[0.4em] text-cyan-300/70">{sv ? 'PUNTOS DE MISIÓN' : 'LUGARES'}</div>
        <button onClick={() => { if (game.goToSunset()) onGo('sunset'); else setNote('Busca un mundo con suelo para ver un atardecer'); }} className="rounded-md border border-amber-300/30 px-3 py-1 text-[11px] tracking-[0.15em] text-amber-100 hover:bg-amber-300/10">IR AL ATARDECER</button>
      </div>
      {cur && (
        <div className="sticky top-0 z-10 mt-3 rounded-xl border border-cyan-300/20 bg-slate-950/95 p-4">
          <div className="text-[10px] tracking-[0.3em] text-white/45">{cur.world.toUpperCase()}{cur.system !== 'Sol' && cur.system !== cur.world ? ` · ${cur.system.toUpperCase()}` : ''}</div>
          <div className={`${touch ? 'text-lg' : 'text-2xl'} font-extralight tracking-[0.12em]`}>{cur.name}</div>
          {cur.status && <div className={`mt-1 text-[11px] tracking-[0.2em] ${tone[cur.status]}`}>{label[cur.status]}</div>}
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/70">{cur.desc}</p>
          <div className="mt-3 flex items-center gap-3">
            <button onClick={() => onGo(cur.id)} className="rounded-lg border border-cyan-300/40 bg-cyan-300/10 px-5 py-2 text-xs tracking-[0.3em] text-cyan-50 hover:bg-cyan-300/20">FIJAR DESTINO</button>
            {game.waypoint?.id === cur.id && <span className="text-[11px] text-cyan-200/70">○ es tu destino actual</span>}
          </div>
        </div>
      )}
      {places.length === 0 && <div className="mt-4 text-sm text-white/50">Todavía no conoces ningún lugar.</div>}
      <div className="mt-5 space-y-4">
        {groups.map((gr) => (
          <div key={gr.key}>
            <div className="mb-1 text-[10px] tracking-[0.3em] text-white/40">{gr.title.toUpperCase()}</div>
            <div className="grid gap-1 md:grid-cols-2">
              {gr.items.map((p) => (
                <button key={p.id} onClick={() => onSel(p.id)} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm hover:bg-white/5 ${cur?.id === p.id ? 'border-cyan-300/40 bg-white/5' : 'border-white/10'}`}>
                  <span className={p.status === 'hecho' ? 'text-white/45' : 'text-white/90'}>{p.name}</span>
                  {p.status && <span className={`text-[10px] tracking-[0.15em] ${tone[p.status]}`}>{p.status === 'hecho' ? '✓' : p.status === 'objetivo' ? '◆' : '·'}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {sv ? (
        // what is left to find
        <div className="mt-8 border-t border-white/10 pt-4 text-[12px] text-white/60">
          <div className="text-[10px] tracking-[0.3em] text-white/40">LO QUE QUEDA POR ENCONTRAR</div>
          <div className="mt-2">Secretos {sv.cachesOpen.size}/{CACHES.length} · Recuerdos {sv.mementos.size}/{MEMENTOS.length} · Pueblos {towns.filter((t) => sv.visited.has(t.id)).length}/{towns.length}</div>
          <div className="mt-2 grid gap-x-6 gap-y-0.5 md:grid-cols-2">
            {towns.filter((t) => sv.visited.has(t.id)).map((t) => {
              const n = LootSystem.crateCount(t.radius);
              const open = [...sv.loot.opened].filter((id) => id.startsWith(`crate:${t.id}:`)).length;
              return <div key={t.id}>✓ {t.name} · cajas {open}/{n}</div>;
            })}
          </div>
        </div>
      ) : (
        // exploration's optional grand tour
        <div className="mt-8 border-t border-white/10 pt-4 text-[12px] text-white/65">
          <div className="text-[10px] tracking-[0.3em] text-white/40">GRAN RECORRIDO ({GRAND_TOUR.filter((t) => game.tour.has(t.id)).length}/{GRAND_TOUR.length})</div>
          <div className="mt-2 space-y-0.5">
            {GRAND_TOUR.map((t) => <div key={t.id} className={game.tour.has(t.id) ? 'text-white/40' : ''}>{game.tour.has(t.id) ? '✓' : '·'} {t.name} <span className="text-white/35">· {t.how}</span></div>)}
          </div>
        </div>
      )}
    </div>
  );
}

export function SystemMap({ game, onClose, touch = false }: { game: Game; onClose: () => void; touch?: boolean }) {
  const [sel, setSel] = useState<string>(game.target?.def.id ?? 'earth');
  const [tab, setTab] = useState<'map' | 'logs' | 'upg' | 'places' | 'diary'>(touch ? 'places' : 'map');
  const places = game.places();
  const [placeSel, setPlaceSel] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const sv = game.surv;
  const heard = sv ? ALL_LOGS.filter((l) => sv.logsRead.has(l.id)) : [];
  const def = BODIES.find((b) => b.id === sel)!;
  const stars = BODIES.filter((b) => b.kind === 'star');
  const planetsOf = (star: typeof stars[number]) => BODIES.filter((b) => b.kind !== 'star' && (b.parent === star.id || (star.id === 'sun' && !b.parent)));
  const parentDef = def.parent ? BODIES.find((b) => b.id === def.parent) : undefined;
  const kindLabel = def.kind === 'gas' ? 'GIGANTE GASEOSO' : def.kind === 'star' ? 'ESTRELLA' : parentDef && parentDef.kind !== 'star' ? `LUNA DE ${parentDef.name.toUpperCase()}` : parentDef ? `EXOPLANETA DE ${parentDef.name.toUpperCase()}` : 'PLANETA ROCOSO';
  const R_EARTH = 6371e3;
  const tabBtn = (id: typeof tab, text: string, tone: string) => (
    <button onClick={() => setTab(tab === id ? 'map' : id)} className={`rounded-md border px-3 py-1.5 ${touch ? 'text-[11px]' : 'text-xs'} tracking-[0.25em] ${tone} ${tab === id ? 'bg-white/10' : ''}`}>{text}</button>
  );
  const pad = touch ? 'p-3' : 'p-8';
  const goBack = () => { onClose(); setTimeout(() => game.requestLock(), 50); };
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/75 font-mono text-white">
      <div className={`flex ${touch ? 'h-[96vh] w-[98vw]' : 'h-[86vh] w-[92vw]'} max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-slate-950/95 to-black/95`}>
        <div className={`flex flex-wrap items-center justify-between gap-2 border-b border-white/10 ${touch ? 'px-3 py-2' : 'px-6 py-4'}`}>
          <div>
            <div className="text-[10px] tracking-[0.5em] text-cyan-300/70">NAVEGACIÓN</div>
            {!touch && <div className="text-2xl font-extralight tracking-[0.2em]">SISTEMAS ESTELARES</div>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tabBtn('places', sv ? 'MISIONES' : 'LUGARES', 'border-cyan-300/30 text-cyan-100')}
            {touch && tabBtn('map', 'MUNDOS', 'border-white/20 text-white/80')}
            {sv && tabBtn('logs', `REGISTROS ${heard.length}`, 'border-amber-300/30 text-amber-100')}
            {sv && tabBtn('upg', `MEJORAS ${sv.upgrades.size}/${UPGRADES.length}`, 'border-violet-300/30 text-violet-100')}
            {tabBtn('diary', 'DIARIO', 'border-white/20 text-white/80')}
            <button onClick={() => { game.surv?.save(); game.saveExplore(); location.reload(); }} className={`rounded-md border border-white/20 px-3 py-1.5 ${touch ? 'text-[11px]' : 'text-xs'} tracking-[0.2em] text-white/60 hover:bg-white/10`}>GUARDAR Y SALIR</button>
            <button onClick={onClose} className={`rounded-md border border-white/30 px-3 py-1.5 ${touch ? 'text-[11px]' : 'text-xs'} tracking-[0.25em] text-white/85 hover:bg-white/10`}>CERRAR{touch ? '' : ' (M)'}</button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          {(!touch || tab === 'map') && (
            <div className={`${touch ? 'w-40' : 'w-72'} overflow-y-auto border-r border-white/10 p-2`}>
              {stars.map((st) => (
                <div key={st.id} className="mb-3">
                  <button onClick={() => setSel(st.id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-white/5 ${sel === st.id ? 'bg-white/10' : ''}`}>
                    <span className="inline-block h-5 w-5 shrink-0 rounded-full" style={{ background: st.markerColor, boxShadow: `0 0 14px ${st.markerColor}` }} />
                    <span className={`${touch ? 'text-[11px]' : 'text-sm'} tracking-[0.2em]`}>{st.name.toUpperCase()}</span>
                    {game.target?.def.id === st.id && <span className="ml-auto text-[10px] text-amber-300">◆</span>}
                  </button>
                  {st.orbit > 0 && !touch && <div className="mb-1 ml-11 text-[10px] text-white/40">a {formatDist(st.orbit)} del Sol</div>}
                  {planetsOf(st).map((p) => (
                    <div key={p.id}>
                      <button onClick={() => setSel(p.id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left hover:bg-white/5 ${sel === p.id ? 'bg-white/10' : ''}`}>
                        <span className="inline-block shrink-0 rounded-full" style={{ width: Math.max(8, Math.min(22, Math.log10(p.radius / 1e5) * 9)), height: Math.max(8, Math.min(22, Math.log10(p.radius / 1e5) * 9)), background: p.markerColor, boxShadow: `0 0 10px ${p.markerColor}` }} />
                        <span className={`${touch ? 'text-[11px]' : 'text-sm'} tracking-wider`}>{p.name}</span>
                        {game.target?.def.id === p.id && <span className="ml-auto text-[10px] text-amber-300">◆</span>}
                      </button>
                      {BODIES.filter((m) => m.parent === p.id).map((m) => (
                        <button key={m.id} onClick={() => setSel(m.id)} className={`ml-6 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-md px-3 py-1 text-left text-xs text-white/70 hover:bg-white/5 ${sel === m.id ? 'bg-white/10 text-white' : ''}`}>
                          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: m.markerColor }} />
                          {m.name}
                          {game.target?.def.id === m.id && <span className="ml-auto text-[10px] text-amber-300">◆</span>}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {tab === 'places' ? (
            <PlacesTab game={game} touch={touch} places={places} sel={placeSel} onSel={setPlaceSel} onGo={(id) => { game.setWaypoint(id); goBack(); }} />
          ) : tab === 'diary' ? (
            <div className={`flex-1 overflow-y-auto ${pad}`}>
              <div className="text-[10px] tracking-[0.4em] text-cyan-300/70">DIARIO DE A BORDO</div>
              {game.journal.length === 0 && <div className="mt-4 text-sm text-white/50">Todavía no hay nada anotado.</div>}
              <div className="mt-3 space-y-1">
                {[...game.journal].reverse().map((j, i) => (
                  <div key={`${j.t}-${i}`} className={`text-[12px] leading-snug ${j.vega ? 'text-cyan-100/80' : 'text-white/75'}`}><span className="mr-2 text-white/35">{fmtClock(j.t)}</span>{j.text}</div>
                ))}
              </div>
            </div>
          ) : tab === 'upg' && sv ? (
            <div className={`flex-1 overflow-y-auto ${pad}`}>
              <div className="text-[10px] tracking-[0.4em] text-violet-300/70">MEJORAS DEL TRAJE Y DE LA NAVE</div>
              <div className="mt-2 text-sm text-white/70">En la bodega: {sv.stored.metal} metal · {sv.stored.crystal} cristal oscuro {game.mode !== 'ship' && <span className="text-white/40">· solo se instalan a bordo</span>}</div>
              {msg && <div className="mt-2 text-xs text-amber-200/80">{msg}</div>}
              <div className="mt-4 grid gap-2 md:grid-cols-2">
                {UPGRADES.map((u) => {
                  const own = sv.upgrades.has(u.id as UpgradeId);
                  return (
                    <div key={u.id} className={`rounded-lg border px-4 py-3 ${own ? 'border-violet-300/30 bg-violet-300/5' : 'border-white/10'}`}>
                      <div className="text-sm text-white/90">{u.name}</div>
                      <div className="text-[11px] text-white/55">{u.desc}</div>
                      <div className="mt-2 flex items-center justify-between text-[11px]">
                        <span className="text-white/45">{u.metal} metal · {u.crystal} cristal</span>
                        {own ? <span className="tracking-[0.2em] text-violet-200/80">INSTALADA</span> : (
                          <button onClick={() => { setMsg(sv.buy(u.id as UpgradeId)); redraw((x) => x + 1); }} className="rounded border border-violet-300/40 px-3 py-1 tracking-[0.2em] text-violet-100 hover:bg-violet-300/15">INSTALAR</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-6 text-[10px] tracking-[0.4em] text-amber-200/70">FABRICAR A BORDO</div>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {CRAFTS.map((c) => (
                  <div key={c.id} className="rounded-lg border border-white/10 px-4 py-3">
                    <div className="text-sm text-white/90">{c.name} <span className="text-white/40">· llevas {c.id === 'medkit' ? sv.medkits : sv.beacons}</span></div>
                    <div className="text-[11px] text-white/55">{c.desc}</div>
                    <div className="mt-2 flex items-center justify-between text-[11px]">
                      <span className="text-white/45">{c.metal} metal · {c.crystal} cristal</span>
                      <button onClick={() => { setMsg(sv.craft(c.id)); redraw((x) => x + 1); }} className="rounded border border-amber-300/40 px-3 py-1 tracking-[0.2em] text-amber-100 hover:bg-amber-300/15">FABRICAR</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-6 text-xs text-white/45">El metal sale de las rocas con vetas, de las cajas y de los naufragios; los cristales, de los lugares de la señal, de los vigías, de las criaturas y de las mantarrayas. Hay alijos escondidos que solo oye el escáner.</div>
            </div>
          ) : tab === 'logs' ? (
            <div className={`flex-1 overflow-y-auto ${pad}`}>
              <div className="text-[10px] tracking-[0.4em] text-amber-300/70">REGISTROS ({heard.length}/{ALL_LOGS.length})</div>
              {heard.length === 0 && <div className="mt-4 text-sm text-white/50">Todavía no has encontrado ninguno.</div>}
              <div className="mt-4 space-y-2">
                {heard.map((l) => (
                  <button key={l.id} onClick={() => { onClose(); game.surv?.openLog(l); }} className="block w-full rounded-lg border border-white/10 px-4 py-3 text-left hover:bg-white/5">
                    <div className="text-sm text-white/90">{l.title}</div>
                    <div className="text-[11px] text-white/45">{l.from}</div>
                  </button>
                ))}
              </div>
              {sv && (
                <>
                  <div className="mt-8 text-[10px] tracking-[0.4em] text-rose-200/70">RECUERDOS DE LA HUMANIDAD ({sv.mementos.size}/{MEMENTOS.length})</div>
                  {sv.mementos.size === 0 && <div className="mt-2 text-sm text-white/50">Búscalos en las cajas de suministros y en los refugios de las ruinas.</div>}
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {MEMENTOS.filter((m) => sv.mementos.has(m.id)).map((m) => (
                      <button key={m.id} onClick={() => { onClose(); sv.openLog({ id: m.id, site: 'memento', title: m.name, from: 'Recuerdo', text: [m.text] }); }} className="rounded-lg border border-white/10 px-4 py-2 text-left text-sm text-white/85 hover:bg-white/5">{m.name}</button>
                    ))}
                  </div>
                </>
              )}
              <div className="mt-6 text-xs text-white/50">Objetivo: {game.surv?.objective().text}</div>
            </div>
          ) : (
            <div className={`relative flex-1 overflow-y-auto ${pad}`}>
              <div className="flex items-start gap-6">
                {!touch && <div className="h-28 w-28 shrink-0 rounded-full" style={{ background: `radial-gradient(circle at 35% 35%, ${def.markerColor}, #000 75%)`, boxShadow: `0 0 40px ${def.markerColor}55` }} />}
                <div>
                  <div className="text-[10px] tracking-[0.4em] text-white/50">{kindLabel}</div>
                  <div className={`${touch ? 'text-2xl' : 'text-4xl'} font-extralight tracking-[0.15em]`}>{def.name}</div>
                  <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/75">{def.description}</p>
                  {def.id === 'earth' && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">En este universo la Tierra está en silencio: sus ciudades están en ruinas. Su historia se cuenta en el modo Supervivencia.</p>}
                </div>
              </div>
              <div className="mt-6 grid grid-cols-2 gap-x-10 gap-y-1 md:grid-cols-3">
                <Row k="Radio" v={`${(def.radius / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} km`} />
                <Row k="Tamaño" v={`${(def.radius / R_EARTH).toFixed(def.radius < R_EARTH * 0.1 ? 4 : 2)} × Tierra`} />
                <Row k="Gravedad" v={`${def.gravity} m/s²`} />
                <Row k="Temperatura" v={def.tempText} />
                <Row k="Presión" v={def.kind === 'gas' ? 'Sin superficie' : fmtPressure(def.pressure)} />
                <Row k={def.parent ? 'Órbita' : 'Distancia al Sol'} v={def.kind === 'star' && def.orbit <= 0 ? '—' : formatDist(def.orbit)} />
              </div>
              <div className="mt-4 text-[11px] uppercase tracking-[0.2em] text-white/45">Atmósfera</div>
              <div className="text-sm text-white/80">{def.composition}</div>
              <div className="mt-6 text-[11px] uppercase tracking-[0.2em] text-white/45">Datos</div>
              <ul className="mt-1 space-y-1 text-sm text-white/75">
                {def.facts.map((f) => <li key={f}>· {f}</li>)}
              </ul>
              {def.hazard?.text && <div className="mt-5 inline-block rounded border border-red-400/30 bg-red-900/20 px-3 py-1 text-xs text-red-200">⚠ {def.hazard.text}</div>}
              <div className="sticky bottom-0 mt-6 flex flex-wrap items-center gap-3 bg-gradient-to-t from-black via-black/90 to-transparent pb-1 pt-4">
                <button onClick={() => { game.setTarget(def.id); goBack(); }} className="rounded-lg border border-amber-300/40 bg-amber-300/15 px-6 py-2.5 text-sm tracking-[0.3em] text-amber-100 hover:bg-amber-300/25">FIJAR DESTINO</button>
                <div className="text-xs text-white/50">Luego pulsa <b className="text-white">{game.keyLabel('KeyJ')}</b> fuera de la atmósfera para saltar a velocidad luz.</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

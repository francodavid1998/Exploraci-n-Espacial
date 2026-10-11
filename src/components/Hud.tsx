import { useEffect, useState } from 'react';
import type { Game, HudState } from '../game/Game';
import { formatDist, formatSpeed } from '../game/Game';
import { BODIES, C_LIGHT } from '../game/bodies';

function Bar({ value, color, label }: { value: number; color: string; label: string }) {
  return (
    <div className="w-44">
      <div className="mb-1 flex justify-between text-[10px] tracking-[0.2em] text-white/60">
        <span>{label}</span>
        <span>{value.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full transition-all duration-200" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} />
      </div>
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
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function fmtPressure(p: number) {
  if (p <= 0) return 'Vacío';
  if (p < 0.001) return `${(p * 1e6).toFixed(1)} µbar`;
  if (p < 0.1) return `${(p * 1000).toFixed(1)} mbar`;
  return `${p.toFixed(p < 10 ? 2 : 0)} bar`;
}

export default function Hud({ game, onOpenMap }: { game: Game; onOpenMap: () => void }) {
  const [s, setS] = useState<HudState | null>(null);
  const [help, setHelp] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setS(game.getHud()), 100);
    const k = (e: KeyboardEvent) => { if (e.code === 'KeyH') setHelp((h) => !h); };
    window.addEventListener('keydown', k);
    return () => { clearInterval(id); window.removeEventListener('keydown', k); };
  }, [game]);
  if (!s) return null;
  const isGas = s.bodyKind === 'Gigante gaseoso';
  const altLabel = isGas ? (s.altitude < 0 ? 'Profundidad' : 'Sobre nubes') : 'Altitud';
  const altVal = isGas && s.altitude < 0 ? formatDist(-s.altitude) : formatDist(s.altitude);
  const c = s.speed / C_LIGHT;

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-mono text-white">
      {/* crosshair */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="h-1 w-1 rounded-full bg-white/70 shadow-[0_0_6px_rgba(255,255,255,0.8)]" />
      </div>

      {/* location panel */}
      <div className="absolute left-5 top-5 w-72 rounded-xl border border-white/10 bg-black/35 p-4 backdrop-blur-md">
        <div className="text-[10px] tracking-[0.3em] text-cyan-300/80">{s.bodyKind.toUpperCase()}</div>
        <div className="mb-2 text-2xl font-light tracking-wider">{s.bodyName}</div>
        <Row k={altLabel} v={altVal} accent={isGas && s.altitude < 0} />
        <Row k="Gravedad" v={`${s.gravity} m/s² · ${(s.gravity / 9.81).toFixed(2)} g`} />
        <Row k="Presión" v={fmtPressure(s.pressure)} accent={s.pressure > 20} />
        <Row k="Temperatura" v={isGas && s.altitude < 0 ? `${s.tempValue.toFixed(0)} °C` : s.temperature} />
        <Row k="Luz solar" v={`${(s.sunlight * 100).toFixed(s.sunlight < 0.1 ? 2 : 0)}% de la Tierra`} />
        <div className="mt-2 border-t border-white/10 pt-2 text-[11px] leading-relaxed text-white/60">{s.composition}</div>
      </div>

      {/* target panel */}
      <div className="absolute right-5 top-5 w-64 rounded-xl border border-white/10 bg-black/35 p-4 backdrop-blur-md">
        <div className="text-[10px] tracking-[0.3em] text-amber-300/80">DESTINO</div>
        {s.targetName ? (
          <>
            <div className="mb-2 text-xl font-light tracking-wider">{s.targetName}</div>
            <Row k="Distancia" v={formatDist(s.targetDist)} />
            <Row k="Luz tarda" v={fmtTime(s.targetDist / C_LIGHT)} />
            <Row k="Salto (pulso)" v={`≈ ${fmtTime(s.eta)}`} accent />
          </>
        ) : (
          <div className="py-2 text-sm text-white/50">Sin destino</div>
        )}
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

      {/* warnings */}
      {s.warnings.length > 0 && (
        <div className="absolute left-1/2 top-20 -translate-x-1/2 space-y-1 text-center">
          {s.warnings.map((w) => (
            <div key={w} className="animate-pulse rounded border border-red-500/60 bg-red-900/40 px-4 py-1 text-sm tracking-[0.25em] text-red-200">⚠ {w}</div>
          ))}
        </div>
      )}

      {/* warp banner */}
      {s.warp && (
        <div className="absolute left-1/2 top-6 -translate-x-1/2 text-center">
          <div className="text-[11px] tracking-[0.5em] text-cyan-200/90">MOTOR DE PULSO ACTIVO</div>
          <div className="text-3xl font-extralight tracking-widest text-cyan-100 drop-shadow-[0_0_12px_rgba(120,200,255,0.8)]">{c >= 1 ? `${c.toFixed(c > 100 ? 0 : 1)} × c` : formatSpeed(s.speed)}</div>
        </div>
      )}

      {/* hint */}
      {s.hint && (
        <div className="absolute bottom-40 left-1/2 -translate-x-1/2 rounded-lg border border-white/15 bg-black/40 px-4 py-2 text-sm tracking-wider text-white/90 backdrop-blur">
          {s.hint}
        </div>
      )}

      {/* bottom center flight data */}
      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-end gap-8 rounded-2xl border border-white/10 bg-black/35 px-7 py-4 backdrop-blur-md">
        <div className="text-center">
          <div className="text-[10px] tracking-[0.3em] text-white/50">VELOCIDAD</div>
          <div className="min-w-[150px] text-3xl font-extralight tracking-wider">{formatSpeed(s.speed)}</div>
          {s.mode === 'ship' && c > 0.0005 && <div className="text-[10px] text-cyan-300/80">{(c * 100).toFixed(c < 0.01 ? 3 : 1)}% velocidad de la luz</div>}
        </div>
        {s.mode === 'ship' ? (
          <div className="flex flex-col gap-2">
            <Bar label="CASCO" value={s.hull} color={s.hull > 50 ? '#7dd3fc' : s.hull > 25 ? '#fbbf24' : '#ef4444'} />
            <Bar label="EMPUJE" value={Math.max(0, s.throttle) * 100} color="#a78bfa" />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Bar label="TRAJE" value={s.suit} color={s.suit > 50 ? '#86efac' : s.suit > 25 ? '#fbbf24' : '#ef4444'} />
            <Bar label="JETPACK" value={s.fuel} color="#7dd3fc" />
          </div>
        )}
        <div className="text-center">
          <div className="text-[10px] tracking-[0.3em] text-white/50">MODO</div>
          <div className="text-sm tracking-widest text-white/85">{s.mode === 'ship' ? (s.warp ? 'PULSO' : s.landed ? 'ATERRIZADO' : 'VUELO') : 'A PIE'}</div>
          <div className="mt-1 text-[10px] text-white/40">{s.lights ? 'LUCES ON' : 'LUCES OFF'}</div>
        </div>
      </div>

      {/* notifications */}
      <div className="absolute bottom-6 left-5 w-96 space-y-1.5">
        {s.notes.map((n) => (
          <div key={n.id} className="rounded-md border-l-2 border-cyan-300/70 bg-black/45 px-3 py-1.5 text-[12px] text-white/90 backdrop-blur">{n.text}</div>
        ))}
      </div>

      {/* help */}
      <div className="absolute bottom-6 right-5 w-64 rounded-xl border border-white/10 bg-black/35 p-3 text-[11px] text-white/70 backdrop-blur-md">
        <div className="mb-1 flex justify-between text-[10px] tracking-[0.25em] text-white/50"><span>CONTROLES</span><span>H</span></div>
        {help && (s.mode === 'ship' ? (
          <div className="space-y-0.5">
            <div><b className="text-white">Ratón</b> cabeceo / guiñada</div>
            <div><b className="text-white">W / S</b> empuje · <b className="text-white">X</b> parar</div>
            <div><b className="text-white">A / D</b> alabeo · <b className="text-white">Shift</b> turbo</div>
            <div><b className="text-white">Espacio / C</b> subir / bajar (vertical)</div>
            <div><b className="text-white">J</b> salto luz (libre) · <b className="text-white">K</b> piloto automático</div>
            <div><b className="text-white">T / M</b> destino · mapa</div>
            <div><b className="text-white">E</b> aterrizar / bajar · <b className="text-white">F</b> luces</div>
            <div><b className="text-white">Rueda</b> distancia cámara</div>
            <div><b className="text-white">G</b> calidad gráfica: {s.quality}</div>
          </div>
        ) : (
          <div className="space-y-0.5">
            <div><b className="text-white">WASD</b> caminar · <b className="text-white">Shift</b> correr</div>
            <div><b className="text-white">Espacio</b> saltar (mantener: jetpack)</div>
            <div><b className="text-white">Ratón</b> cámara · <b className="text-white">Rueda</b> zoom</div>
            <div><b className="text-white">E</b> subir a la nave · <b className="text-white">F</b> linterna</div>
            <div><b className="text-white">G</b> calidad gráfica: {s.quality}</div>
          </div>
        ))}
      </div>

      {!s.locked && !s.dead && (
        <div className="absolute left-1/2 top-1/2 mt-10 -translate-x-1/2 rounded-full border border-white/20 bg-black/50 px-5 py-2 text-xs tracking-[0.25em] text-white/80 backdrop-blur">
          HAZ CLIC PARA TOMAR EL CONTROL
        </div>
      )}

      {s.dead && (
        <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="max-w-xl rounded-2xl border border-red-500/30 bg-black/70 p-8 text-center">
            <div className="mb-2 text-[11px] tracking-[0.5em] text-red-400">SEÑAL PERDIDA</div>
            <div className="mb-6 text-lg font-light leading-relaxed text-white/90">{s.dead}</div>
            <button
              onClick={() => { game.revive(); setTimeout(() => game.requestLock(), 50); }}
              className="rounded-lg border border-cyan-300/40 bg-cyan-300/10 px-6 py-2 tracking-[0.3em] text-cyan-100 hover:bg-cyan-300/20"
            >
              REAPARECER
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SystemMap({ game, onClose }: { game: Game; onClose: () => void }) {
  const [sel, setSel] = useState<string>(game.target?.def.id ?? 'earth');
  const def = BODIES.find((b) => b.id === sel)!;
  const planets = BODIES.filter((b) => !b.parent);
  const R_EARTH = 6371e3;
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/75 font-mono text-white backdrop-blur-md">
      <div className="flex h-[86vh] w-[92vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-slate-950/90 to-black/90">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div>
            <div className="text-[10px] tracking-[0.5em] text-cyan-300/70">NAVEGACIÓN</div>
            <div className="text-2xl font-extralight tracking-[0.2em]">SISTEMA SOLAR</div>
          </div>
          <button onClick={onClose} className="rounded-md border border-white/20 px-4 py-1.5 text-xs tracking-[0.3em] text-white/80 hover:bg-white/10">CERRAR (M)</button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-72 overflow-y-auto border-r border-white/10 p-3">
            {planets.map((p) => (
              <div key={p.id}>
                <button onClick={() => setSel(p.id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-white/5 ${sel === p.id ? 'bg-white/10' : ''}`}>
                  <span className="inline-block rounded-full" style={{ width: Math.max(8, Math.min(22, Math.log10(p.radius / 1e5) * 9)), height: Math.max(8, Math.min(22, Math.log10(p.radius / 1e5) * 9)), background: p.markerColor, boxShadow: `0 0 10px ${p.markerColor}` }} />
                  <span className="text-sm tracking-wider">{p.name}</span>
                  {game.target?.def.id === p.id && <span className="ml-auto text-[10px] text-amber-300">◆</span>}
                </button>
                {BODIES.filter((m) => m.parent === p.id).map((m) => (
                  <button key={m.id} onClick={() => setSel(m.id)} className={`ml-6 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-md px-3 py-1 text-left text-xs text-white/70 hover:bg-white/5 ${sel === m.id ? 'bg-white/10 text-white' : ''}`}>
                    <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: m.markerColor }} />
                    {m.name}
                    {game.target?.def.id === m.id && <span className="ml-auto text-[10px] text-amber-300">◆</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-8">
            <div className="flex items-start gap-6">
              <div className="h-28 w-28 shrink-0 rounded-full" style={{ background: `radial-gradient(circle at 35% 35%, ${def.markerColor}, #000 75%)`, boxShadow: `0 0 40px ${def.markerColor}55` }} />
              <div>
                <div className="text-[10px] tracking-[0.4em] text-white/50">{def.kind === 'gas' ? 'GIGANTE GASEOSO' : def.kind === 'star' ? 'ESTRELLA' : def.parent ? `LUNA DE ${BODIES.find((b) => b.id === def.parent)!.name.toUpperCase()}` : 'PLANETA ROCOSO'}</div>
                <div className="text-4xl font-extralight tracking-[0.15em]">{def.name}</div>
                <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/75">{def.description}</p>
              </div>
            </div>
            <div className="mt-8 grid grid-cols-2 gap-x-10 gap-y-1 md:grid-cols-3">
              <Row k="Radio" v={`${(def.radius / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} km`} />
              <Row k="Tamaño" v={`${(def.radius / R_EARTH).toFixed(def.radius < R_EARTH * 0.1 ? 4 : 2)} × Tierra`} />
              <Row k="Gravedad" v={`${def.gravity} m/s²`} />
              <Row k="Temperatura" v={def.tempText} />
              <Row k="Presión" v={def.kind === 'gas' ? 'Sin superficie' : fmtPressure(def.pressure)} />
              <Row k={def.parent ? 'Órbita' : 'Distancia al Sol'} v={def.kind === 'star' ? '—' : formatDist(def.orbit)} />
            </div>
            <div className="mt-4 text-[11px] uppercase tracking-[0.2em] text-white/45">Atmósfera</div>
            <div className="text-sm text-white/80">{def.composition}</div>
            <div className="mt-6 text-[11px] uppercase tracking-[0.2em] text-white/45">Datos</div>
            <ul className="mt-1 space-y-1 text-sm text-white/75">
              {def.facts.map((f) => <li key={f}>· {f}</li>)}
            </ul>
            {def.hazard?.text && <div className="mt-5 inline-block rounded border border-red-400/30 bg-red-900/20 px-3 py-1 text-xs text-red-200">⚠ {def.hazard.text}</div>}
            <div className="mt-8 flex gap-3">
              <button
                onClick={() => { game.setTarget(def.id); onClose(); setTimeout(() => game.requestLock(), 50); }}
                className="rounded-lg border border-amber-300/40 bg-amber-300/10 px-6 py-2.5 text-sm tracking-[0.3em] text-amber-100 hover:bg-amber-300/20"
              >
                FIJAR DESTINO
              </button>
              <div className="self-center text-xs text-white/50">Luego pulsa <b className="text-white">J</b> fuera de la atmósfera para saltar a velocidad luz.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

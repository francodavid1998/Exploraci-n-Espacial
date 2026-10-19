import { useEffect, useRef, useState } from 'react';
import type { Game } from '../game/Game';

/** every key these controls can hold: let go of all of them when the controls go away (the map opened) */
const HELD = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'Space', 'KeyC', 'KeyR', 'KeyQ', 'Mouse0'];

/**
 * A button that holds a key while pressed; the first touch also counts as a key press (jump,
 * listen, open). With `look`, dragging the finger on it turns the camera too (aim while firing).
 */
function HoldButton({ game, code, label, look = false, small = false }: { game: Game; code: string; label: string; look?: boolean; small?: boolean }) {
  const last = useRef<{ x: number; y: number } | null>(null);
  const up = () => { game.keys.delete(code); last.current = null; };
  // a button that goes away while held (▼ on landing, the layout changing) must let go of its key
  useEffect(() => () => { game.keys.delete(code); }, [game, code]);
  return (
    <button
      className={`${small ? 'h-12 w-12 text-[11px]' : 'h-14 w-14 text-[12px]'} rounded-full border border-white/25 bg-black/35 tracking-wide text-white/85 active:bg-white/25`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        if (!game.keys.has(code)) game.pressed.add(code);
        game.keys.add(code);
        last.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        const l = last.current;
        if (!look || !l) return;
        game.touchLook((e.clientX - l.x) * 1.6, (e.clientY - l.y) * 1.6);
        l.x = e.clientX; l.y = e.clientY;
      }}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
    >
      {label}
    </button>
  );
}

/** A button that sends one key press. */
function TapButton({ game, code, label, accent = false }: { game: Game; code: string; label: string; accent?: boolean }) {
  return (
    <button
      className={`h-11 min-w-[44px] rounded-lg border px-2.5 text-[11px] tracking-wider active:bg-white/25 ${accent ? 'border-amber-300/40 bg-black/35 text-amber-100' : 'border-white/25 bg-black/35 text-white/85'}`}
      onPointerDown={() => game.pressed.add(code)}
    >
      {label}
    </button>
  );
}

/** what USAR does here, said in one word */
function actionLabel(prompt: string | null | undefined) {
  if (!prompt) return 'MINAR';
  if (prompt.startsWith('escuchar')) return 'OÍR';
  if (prompt.startsWith('abrir') || prompt.startsWith('entrar') || prompt.startsWith('registrar')) return 'ABRIR';
  if (prompt.startsWith('leer') || prompt.startsWith('traducir') || prompt.startsWith('tocar') || prompt.startsWith('examinar')) return 'LEER';
  return 'USAR';
}

/**
 * On-screen controls for phones and tablets (no keyboard, no pointer lock). They drive
 * the game exactly like the keyboard does: held buttons put key codes in game.keys,
 * taps in game.pressed, and dragging anywhere else turns the camera like the mouse
 * (two fingers: zoom the camera in and out).
 *   - left stick: W/S (thrust or walk) and A/D (roll or strafe)
 *   - right: fire (drag to aim), use / mine, dodge, run (a switch), down / up
 *   - above: jump, land / board, vision; lights, heal, weapon, beacon, destination, autopilot, map
 */
export default function TouchControls({ game }: { game: Game }) {
  const [st, setSt] = useState(() => ({ mode: game.mode, vision: game.vision, vmode: game.visionMode, prompt: null as string | null, air: false, beacons: 0, landed: game.landed, lights: game.lightsOn }));
  const [run, setRun] = useState(false);
  const stick = useRef<{ id: number; x: number; y: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const R = 56; // stick radius, CSS px

  // ship or on foot (and vision mode, what USAR would do) decide which buttons make sense
  useEffect(() => {
    const id = setInterval(() => setSt({
      mode: game.mode, vision: game.vision, vmode: game.visionMode, prompt: game.surv?.currentPrompt ?? null,
      air: game.mode === 'foot' && !game.onGround, beacons: game.surv?.beacons ?? 0, landed: game.landed, lights: game.lightsOn,
    }), 250);
    return () => {
      clearInterval(id);
      // going away (the map opened): nothing stays held
      for (const c of HELD) game.keys.delete(c);
    };
  }, [game]);
  // running is a switch on foot; boarding the ship turns it off
  useEffect(() => {
    if (st.mode === 'ship' && run) { setRun(false); game.keys.delete('ShiftLeft'); }
  }, [st.mode, run, game]);

  const setStickKeys = (dx: number, dy: number) => {
    const k = game.keys;
    const set = (code: string, on: boolean) => (on ? k.add(code) : k.delete(code));
    set('KeyW', dy < -0.35);
    set('KeyS', dy > 0.35);
    set('KeyA', dx < -0.35);
    set('KeyD', dx > 0.35);
  };
  const onStickMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = stick.current;
    if (!s || s.id !== e.pointerId) return;
    let dx = (e.clientX - s.x) / R, dy = (e.clientY - s.y) / R;
    const l = Math.hypot(dx, dy);
    if (l > 1) { dx /= l; dy /= l; }
    setKnob({ x: dx * R, y: dy * R });
    setStickKeys(dx, dy);
  };
  const onStickDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    stick.current = { id: e.pointerId, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    onStickMove(e);
  };
  const onStickUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (stick.current?.id !== e.pointerId) return;
    stick.current = null;
    setKnob({ x: 0, y: 0 });
    setStickKeys(0, 0);
  };

  // the background: one finger looks around, two fingers pinch the camera closer or farther
  const spread = () => {
    const p = [...pointers.current.values()];
    return p.length >= 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : null;
  };
  const onLookDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch.current = spread();
  };
  const onLookMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const l = pointers.current.get(e.pointerId);
    if (!l) return;
    const dx = e.clientX - l.x, dy = e.clientY - l.y;
    l.x = e.clientX; l.y = e.clientY;
    if (pointers.current.size >= 2) {
      const d = spread();
      if (d && pinch.current) game.zoomCam(Math.max(0.8, Math.min(1.25, pinch.current / d)));
      pinch.current = d;
      return;
    }
    game.touchLook(dx * 1.6, dy * 1.6);
  };
  const onLookUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    pinch.current = spread();
  };

  const ship = st.mode === 'ship';
  const surv = !!game.surv;
  const toggleRun = () => {
    const on = !run;
    setRun(on);
    if (on) game.keys.add('ShiftLeft'); else game.keys.delete('ShiftLeft');
  };
  return (
    <div className="absolute inset-0 select-none font-mono" style={{ touchAction: 'none' }}>
      {/* drag anywhere to look / steer; pinch to zoom */}
      <div className="absolute inset-0" onPointerDown={onLookDown} onPointerMove={onLookMove} onPointerUp={onLookUp} onPointerCancel={onLookUp} />

      {/* left stick */}
      <div
        className="absolute bottom-6 left-6 rounded-full border border-white/25 bg-black/25"
        style={{ width: R * 2, height: R * 2, marginBottom: 'env(safe-area-inset-bottom)' }}
        onPointerDown={onStickDown}
        onPointerMove={onStickMove}
        onPointerUp={onStickUp}
        onPointerCancel={onStickUp}
      >
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 h-12 w-12 rounded-full border border-white/40 bg-white/15"
          style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
        />
        <div className="pointer-events-none absolute -top-5 left-0 w-full text-center text-[10px] tracking-[0.2em] text-white/50">
          {ship ? 'EMPUJE · ALABEO' : 'CAMINAR'}
        </div>
      </div>

      {st.vision ? (
        // vision mode: just the zoom, the photo and the way on, faint, so the sky stays clean
        <div className="absolute bottom-5 right-5 flex items-end gap-3 opacity-60">
          {st.vmode === 'eyes' && <button className="h-12 w-12 rounded-full border border-white/25 bg-black/30 text-lg text-white/80 active:bg-white/25" onPointerDown={() => game.zoomVision(1 / 1.6)}>+</button>}
          {st.vmode === 'eyes' && <button className="h-12 w-12 rounded-full border border-white/25 bg-black/30 text-lg text-white/80 active:bg-white/25" onPointerDown={() => game.zoomVision(1.6)}>−</button>}
          <button className="h-12 rounded-full border border-white/25 bg-black/30 px-4 text-xs tracking-wider text-white/80 active:bg-white/25" onPointerDown={() => game.takePhoto()}>FOTO</button>
          <button className="h-12 rounded-full border border-white/25 bg-black/30 px-4 text-xs tracking-wider text-white/80 active:bg-white/25" onPointerDown={() => game.cycleVision()}>{st.vmode === 'eyes' ? 'EXTERIOR' : 'SALIR'}</button>
        </div>
      ) : (
        <>
          {/* right, bottom row: held controls */}
          <div className="absolute bottom-5 right-4 flex items-end gap-2" style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
            {surv && <HoldButton game={game} code="Mouse0" label="FUEGO" look />}
            {!ship && surv && <HoldButton game={game} code="KeyR" label={actionLabel(st.prompt)} />}
            {!ship && surv && <HoldButton game={game} code="KeyQ" label="ESQ" small />}
            {ship ? <HoldButton game={game} code="ShiftLeft" label="TURBO" look /> : (
              <button
                className={`h-14 w-14 rounded-full border text-[11px] tracking-wide active:bg-white/25 ${run ? 'border-cyan-300/60 bg-cyan-300/20 text-cyan-50' : 'border-white/25 bg-black/35 text-white/85'}`}
                onPointerDown={toggleRun}
              >
                CORRER
              </button>
            )}
            {(ship || st.air) && <HoldButton game={game} code="KeyC" label="▼" />}
            <HoldButton game={game} code="Space" label="▲" look />
          </div>

          {/* right, above them: actions in short rows (fits a landscape phone, 360 px tall) */}
          <div className="absolute bottom-[90px] right-4 flex flex-col items-end gap-2" style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
            <div className="flex gap-2">
              {ship && <TapButton game={game} code="KeyJ" label="SALTO" />}
              <TapButton game={game} code="KeyE" label={ship ? (st.landed ? 'BAJAR' : 'ATERRIZAR') : 'NAVE'} />
              <button className="h-11 rounded-lg border border-white/25 bg-black/35 px-2.5 text-[11px] tracking-wider text-white/85 active:bg-white/25" onPointerDown={() => game.cycleVision()}>VER</button>
              <TapButton game={game} code="KeyF" label={st.lights ? 'LUZ ✓' : 'LUZ'} />
            </div>
            <div className="flex gap-2">
              {ship && <TapButton game={game} code="KeyX" label="PARAR" />}
              {!ship && surv && <TapButton game={game} code="KeyB" label="CURAR" />}
              {!ship && surv && <TapButton game={game} code="WeaponToggle" label="ARMA" />}
              {!ship && surv && st.beacons > 0 && <TapButton game={game} code="KeyZ" label="BALIZA" />}
              {(ship || !surv) && <TapButton game={game} code="KeyT" label="DESTINO" />}
              {ship && <TapButton game={game} code="KeyK" label="AUTO" />}
              <button
                className="h-11 rounded-lg border border-amber-300/40 bg-black/35 px-3 text-[11px] tracking-wider text-amber-100 active:bg-amber-300/20"
                onPointerDown={() => game.toggleMenu(true)}
              >
                MAPA
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

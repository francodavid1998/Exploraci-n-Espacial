import { useEffect, useRef, useState } from 'react';
import type { Game } from '../game/Game';

/** A button that holds a key while pressed. */
function HoldButton({ game, code, label }: { game: Game; code: string; label: string }) {
  return (
    <button
      className="h-14 w-14 rounded-full border border-white/25 bg-black/35 text-sm text-white/85 active:bg-white/25"
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); game.keys.add(code); }}
      onPointerUp={() => game.keys.delete(code)}
      onPointerCancel={() => game.keys.delete(code)}
      onLostPointerCapture={() => game.keys.delete(code)}
    >
      {label}
    </button>
  );
}

/** A button that sends one key press. */
function TapButton({ game, code, label, wide }: { game: Game; code: string; label: string; wide?: boolean }) {
  return (
    <button
      className={`h-11 ${wide ? 'px-3' : 'w-11'} rounded-lg border border-white/25 bg-black/35 text-xs tracking-wider text-white/85 active:bg-white/25`}
      onPointerDown={() => game.pressed.add(code)}
    >
      {label}
    </button>
  );
}

/**
 * On-screen controls for phones and tablets (no keyboard, no pointer lock). They drive
 * the game exactly like the keyboard does: held buttons put key codes in game.keys,
 * taps in game.pressed, and dragging anywhere else turns the camera like the mouse.
 *   - left stick: W/S (thrust or walk) and A/D (roll or strafe)
 *   - drag: look around / steer the ship
 *   - buttons: up/down, turbo, land/exit (E), pulse jump (J), stop, lights, target, autopilot, map
 */
export default function TouchControls({ game }: { game: Game }) {
  const [mode, setMode] = useState(game.mode);
  const [vision, setVision] = useState(game.vision);
  const stick = useRef<{ id: number; x: number; y: number } | null>(null);
  const look = useRef<{ id: number; x: number; y: number } | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const R = 56; // stick radius, CSS px

  // ship or on foot (and vision mode) decide which buttons make sense
  useEffect(() => {
    const id = setInterval(() => { setMode(game.mode); setVision(game.vision); }, 250);
    return () => clearInterval(id);
  }, [game]);

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

  const onLookDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    look.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onLookMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const l = look.current;
    if (!l || l.id !== e.pointerId) return;
    game.touchLook((e.clientX - l.x) * 1.6, (e.clientY - l.y) * 1.6);
    l.x = e.clientX; l.y = e.clientY;
  };
  const onLookUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (look.current?.id === e.pointerId) look.current = null;
  };

  const ship = mode === 'ship';
  return (
    <div className="absolute inset-0 select-none font-mono" style={{ touchAction: 'none' }}>
      {/* drag anywhere to look / steer */}
      <div className="absolute inset-0" onPointerDown={onLookDown} onPointerMove={onLookMove} onPointerUp={onLookUp} onPointerCancel={onLookUp} />

      {/* left stick */}
      <div
        className="absolute bottom-6 left-6 rounded-full border border-white/25 bg-black/25"
        style={{ width: R * 2, height: R * 2 }}
        onPointerDown={onStickDown}
        onPointerMove={onStickMove}
        onPointerUp={onStickUp}
        onPointerCancel={onStickUp}
      >
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 h-12 w-12 rounded-full border border-white/40 bg-white/15"
          style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
        />
        <div className="pointer-events-none absolute -top-5 left-0 w-full text-center text-[9px] tracking-[0.2em] text-white/50">
          {ship ? 'EMPUJE · ALABEO' : 'CAMINAR'}
        </div>
      </div>

      {vision ? (
        // vision mode: just the zoom and the way out, faint, so the sky stays clean
        <div className="absolute bottom-5 right-5 flex items-end gap-3 opacity-60">
          <button className="h-12 w-12 rounded-full border border-white/25 bg-black/30 text-lg text-white/80 active:bg-white/25" onPointerDown={() => game.zoomVision(1 / 1.6)}>+</button>
          <button className="h-12 w-12 rounded-full border border-white/25 bg-black/30 text-lg text-white/80 active:bg-white/25" onPointerDown={() => game.zoomVision(1.6)}>−</button>
          <button className="h-12 rounded-full border border-white/25 bg-black/30 px-4 text-xs tracking-wider text-white/80 active:bg-white/25" onPointerDown={() => game.toggleVision(false)}>VER</button>
        </div>
      ) : (
        <>
          {/* right, bottom row: held controls */}
          <div className="absolute bottom-5 right-5 flex items-end gap-3">
            <HoldButton game={game} code="ShiftLeft" label={ship ? 'TURBO' : 'CORRER'} />
            {ship && <HoldButton game={game} code="KeyC" label="▼" />}
            <HoldButton game={game} code="Space" label="▲" />
          </div>

          {/* right, above them: actions in short rows (fits a landscape phone, 360 px tall) */}
          <div className="absolute bottom-[92px] right-5 flex flex-col items-end gap-2">
            <div className="flex gap-2">
              {ship && <TapButton game={game} code="KeyJ" label="SALTO" wide />}
              <TapButton game={game} code="KeyE" label={ship ? 'ATERRIZAR' : 'NAVE'} wide />
              <button
                className="h-11 rounded-lg border border-white/25 bg-black/35 px-3 text-xs tracking-wider text-white/85 active:bg-white/25"
                onPointerDown={() => game.toggleVision(true)}
              >
                VER
              </button>
            </div>
            <div className="flex gap-2">
              {ship && <TapButton game={game} code="KeyX" label="PARAR" wide />}
              <TapButton game={game} code="KeyF" label="F" />
              <TapButton game={game} code="KeyT" label="T" />
              {ship && <TapButton game={game} code="KeyK" label="K" />}
              <button
                className="h-11 rounded-lg border border-amber-300/40 bg-black/35 px-3 text-xs tracking-wider text-amber-100 active:bg-amber-300/20"
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

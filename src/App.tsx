import { useEffect, useRef, useState } from 'react';
import { Game, IS_TOUCH, type LightsMode } from './game/Game';
import Hud, { SystemMap } from './components/Hud';
import TouchControls from './components/TouchControls';
import { Survival } from './game/survival';

/** "1 h 12 min" of play in a saved game */
function playTime(s: number) {
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [started, setStarted] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lights, setLights] = useState<LightsMode>('comfort');
  // survival: the saved game (if any) and the "are you sure?" step of a new game over it
  const [save] = useState(() => Survival.load());
  const [confirmNew, setConfirmNew] = useState(false);

  useEffect(() => {
    if (!containerRef.current || !markerRef.current) return;
    let g: Game | null = null;
    const id = setTimeout(() => {
      try {
        g = new Game(containerRef.current!, markerRef.current!);
        g.onMenuToggle = (o) => setMenu(o);
        g.touchMode = IS_TOUCH;
        g.onLightsModeChange = (m) => setLights(m); // L on the title screen must update its button
        if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) (window as unknown as { __game?: Game }).__game = g; // debug hook (dev only)
        setLights(g.lightsMode);
        setGame(g);
      } catch (e) {
        console.error(e);
        setError('No se pudo iniciar WebGL2. Usa un navegador moderno con aceleración por hardware.');
      }
    }, 50);
    return () => {
      clearTimeout(id);
      g?.dispose();
    };
  }, []);

  useEffect(() => {
    if (game) game.menuOpen = !started || menu;
  }, [game, started, menu]);

  const start = (mode: 'explore' | 'survival', continueSave = false) => {
    if (!game) return;
    if (mode === 'survival' && !continueSave && save && !confirmNew) { setConfirmNew(true); return; }
    setStarted(true);
    if (game) {
      game.started = true;
      game.menuOpen = false;
      game.requestLock();
      const jump = IS_TOUCH ? 'SALTO' : 'J';
      if (mode === 'explore') game.note(`Órbita terrestre. Destino: la Luna. Pulsa ${jump} para saltar.`);
      else if (game.startSurvival(continueSave)) game.note('Partida cargada. Estás a bordo de tu nave');
      else {
        game.note('SUPERVIVENCIA · Combustible al 60%. Cada salto lo gasta: más cuanto más lejos');
        game.note(`Aterriza en la Luna y extrae hielo (combustible) y metal (reparaciones) con ${IS_TOUCH ? 'MINAR' : 'R'}`);
        game.note('El oxígeno del traje dura 6 minutos. La nave lo recarga');
      }
      if (IS_TOUCH) {
        // phones: full screen, landscape (both may be refused; the game works anyway)
        document.documentElement.requestFullscreen?.().then(
          () => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {}),
          () => {},
        );
      }
    }
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      <div ref={containerRef} className="absolute inset-0" />
      <div ref={markerRef} className={`pointer-events-none absolute inset-0 overflow-hidden ${started ? '' : 'hidden'}`} />

      {game && started && !menu && IS_TOUCH && <TouchControls game={game} />}
      {game && started && <Hud game={game} touch={IS_TOUCH} onOpenMap={() => game.toggleMenu(true)} />}
      {game && started && menu && <SystemMap game={game} onClose={() => { game.toggleMenu(false); }} />}

      {!started && (
        // phones in landscape have ~360 px of height: a compact screen that can scroll
        <div className={`absolute inset-0 flex justify-center overflow-y-auto bg-gradient-to-b from-black/30 via-black/10 to-black/80 font-mono text-white ${IS_TOUCH ? 'items-start py-3' : 'items-center'}`}>
          <div className="max-w-2xl px-6 text-center">
            {!IS_TOUCH && <div className="mb-3 text-[11px] tracking-[0.8em] text-cyan-300/80">SIMULADOR DE EXPLORACIÓN</div>}
            <h1 className={`${IS_TOUCH ? 'text-4xl' : 'text-6xl md:text-7xl'} font-extralight tracking-[0.35em] drop-shadow-[0_0_30px_rgba(120,180,255,0.5)]`}>HELIOS</h1>
            <div className={`${IS_TOUCH ? 'mt-1 text-[10px]' : 'mt-2 text-sm'} tracking-[0.4em] text-white/60`}>EL SISTEMA SOLAR REAL</div>
            {!IS_TOUCH && (
              <p className="mx-auto mt-6 max-w-xl text-sm leading-relaxed text-white/70">
                Del Sol a Neptuno a escala real. Salta entre mundos a velocidad luz, atraviesa atmósferas,
                aterriza y camina sobre la Luna, Marte, Titán o Europa. Y cruza 4,2 años luz hasta Próxima Centauri,
                o 40 hasta TRAPPIST-1 y sus siete mundos del tamaño de la Tierra.
              </p>
            )}
            {/* the two ways to play */}
            <div className={`mx-auto ${IS_TOUCH ? 'mt-3' : 'mt-8'} grid max-w-2xl grid-cols-2 gap-4 text-left`}>
              <div className={`flex flex-col rounded-2xl border border-cyan-200/25 bg-black/40 ${IS_TOUCH ? 'p-3' : 'p-5'} backdrop-blur`}>
                <div className="text-[10px] tracking-[0.4em] text-cyan-300/80">MODO</div>
                <div className={`${IS_TOUCH ? 'text-sm' : 'text-lg'} font-light tracking-[0.2em]`}>EXPLORACIÓN REALISTA</div>
                <p className="mt-2 flex-1 text-[12px] leading-relaxed text-white/60">El universo real, sin peligros añadidos. Viaja, aterriza y contempla.</p>
                <button
                  disabled={!game}
                  onClick={() => start('explore')}
                  className="mt-4 rounded-full border border-cyan-200/40 bg-cyan-200/10 py-2.5 text-xs tracking-[0.4em] text-cyan-50 transition hover:bg-cyan-200/20 disabled:opacity-40"
                >
                  {game ? 'EXPLORAR' : 'GENERANDO MUNDOS…'}
                </button>
              </div>
              <div className={`flex flex-col rounded-2xl border border-red-300/20 bg-black/50 ${IS_TOUCH ? 'p-3' : 'p-5'} backdrop-blur`}>
                <div className="text-[10px] tracking-[0.4em] text-red-300/70">MODO</div>
                <div className={`${IS_TOUCH ? 'text-sm' : 'text-lg'} font-light tracking-[0.2em]`}>SUPERVIVENCIA</div>
                <p className="mt-2 flex-1 text-[12px] leading-relaxed text-white/60">
                  Oxígeno, batería y combustible limitados. Extrae hielo y metal para seguir viajando. Nadie contesta por radio.
                </p>
                {save && !confirmNew && (
                  <button
                    disabled={!game}
                    onClick={() => start('survival', true)}
                    className="mt-4 rounded-full border border-red-200/40 bg-red-200/10 py-2.5 text-xs tracking-[0.4em] text-red-50 transition hover:bg-red-200/20 disabled:opacity-40"
                  >
                    CONTINUAR <span className="tracking-normal text-white/50">· {playTime(save.playTime)}</span>
                  </button>
                )}
                <button
                  disabled={!game}
                  onClick={() => start('survival')}
                  className={`${save && !confirmNew ? 'mt-2 border-white/20 text-white/70' : 'mt-4 border-red-200/40 bg-red-200/10 text-red-50'} rounded-full border py-2.5 text-xs tracking-[0.3em] transition hover:bg-red-200/20 disabled:opacity-40`}
                >
                  {confirmNew ? '¿BORRAR LA PARTIDA? PULSA OTRA VEZ' : 'NUEVA PARTIDA'}
                </button>
              </div>
            </div>
            <div className="mt-4 text-[11px] text-white/60">
              Luces:{' '}
              <button
                disabled={!game}
                onClick={() => game?.setLightsMode(lights === 'comfort' ? 'bright' : 'comfort')}
                className="pointer-events-auto rounded border border-white/20 px-2 py-0.5 text-white/80 hover:bg-white/10 disabled:opacity-40"
              >
                {lights === 'comfort' ? 'cómodas' : 'brillantes'}
              </button>
              {!IS_TOUCH && <span className="ml-2 text-white/40">(cambiar con L durante el juego)</span>}
            </div>
            {!IS_TOUCH && (
              <div className="mt-8 grid grid-cols-3 gap-4 text-[11px] text-white/50">
                <div><b className="block text-white/80">Ratón + WASD</b>pilotar / caminar</div>
                <div><b className="block text-white/80">J</b>salto a velocidad luz</div>
                <div><b className="block text-white/80">E</b>aterrizar y bajar</div>
              </div>
            )}
            {error && <div className="mt-6 text-sm text-red-300">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

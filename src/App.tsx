import { useEffect, useRef, useState } from 'react';
import { Game, IS_TOUCH, type LightsMode } from './game/Game';
import Hud, { SystemMap } from './components/Hud';
import TouchControls from './components/TouchControls';

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [started, setStarted] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lights, setLights] = useState<LightsMode>('comfort');

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

  const start = () => {
    setStarted(true);
    if (game) {
      game.started = true;
      game.menuOpen = false;
      game.requestLock();
      game.note(IS_TOUCH ? 'Órbita terrestre. Destino: la Luna. Pulsa SALTO para saltar.' : 'Órbita terrestre. Destino: la Luna. Pulsa J para saltar.');
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
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-black/30 via-black/10 to-black/80 font-mono text-white">
          <div className="max-w-2xl px-6 text-center">
            <div className="mb-3 text-[11px] tracking-[0.8em] text-cyan-300/80">SIMULADOR DE EXPLORACIÓN</div>
            <h1 className="text-6xl font-extralight tracking-[0.35em] drop-shadow-[0_0_30px_rgba(120,180,255,0.5)] md:text-7xl">HELIOS</h1>
            <div className="mt-2 text-sm tracking-[0.4em] text-white/60">EL SISTEMA SOLAR REAL</div>
            <p className="mx-auto mt-8 max-w-xl text-sm leading-relaxed text-white/70">
              Del Sol a Neptuno a escala real. Pilota tu nave, salta entre mundos a velocidad luz, atraviesa atmósferas,
              aterriza y camina sobre la Luna, Marte, Titán o Europa. Desciende en Júpiter… si te atreves: no hay suelo, solo presión.
              Y cruza 4,2 años luz hasta Próxima Centauri, la estrella más cercana, o 40 hasta TRAPPIST-1 y sus siete mundos del tamaño de la Tierra.
            </p>
            <button
              disabled={!game}
              onClick={start}
              className="mt-10 rounded-full border border-cyan-200/40 bg-cyan-200/10 px-10 py-3 text-sm tracking-[0.5em] text-cyan-50 shadow-[0_0_40px_rgba(100,200,255,0.25)] transition hover:bg-cyan-200/20 disabled:opacity-40"
            >
              {game ? 'INICIAR' : 'GENERANDO MUNDOS…'}
            </button>
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
            <div className="mt-8 grid grid-cols-3 gap-4 text-[11px] text-white/50">
              <div><b className="block text-white/80">{IS_TOUCH ? 'Mando + arrastrar' : 'Ratón + WASD'}</b>pilotar / caminar</div>
              <div><b className="block text-white/80">{IS_TOUCH ? 'SALTO' : 'J'}</b>salto a velocidad luz</div>
              <div><b className="block text-white/80">{IS_TOUCH ? 'ATERRIZAR' : 'E'}</b>aterrizar y bajar</div>
            </div>
            {error && <div className="mt-6 text-sm text-red-300">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

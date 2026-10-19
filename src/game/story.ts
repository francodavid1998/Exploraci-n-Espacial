/**
 * Survival mode story, phase 2: what happened to humanity, told by the last survivors'
 * recordings in the ruins of Earth. Each recording points to the next place; the last
 * one sends the pilot to the far side of the Moon (phase 4).
 */

export interface LogEntry {
  id: string;
  /** ruin site where it is found */
  site: string;
  title: string;
  from: string;
  text: string[];
}

/** what the ship's computer says when the pilot wakes up (new game) */
export const WAKE_LINES = [
  'CRIOSUEÑO INTERRUMPIDO',
  'Constantes vitales estables. Bienvenido de vuelta, piloto.',
  'Reloj de a bordo dañado. Última señal de la Tierra: hace 3 años.',
  'Llamando a Control de Misión… sin respuesta.',
  'Barrido en todas las frecuencias… silencio.',
  'Una baliza de emergencia sigue emitiendo en la superficie: Nueva Esperanza.',
];

export const LOGS: LogEntry[] = [
  {
    id: 'beacon', site: 'esperanza',
    title: 'Baliza de emergencia', from: 'Estación de Evacuación 7 · mensaje automático',
    text: [
      'Este es un mensaje automático de la Estación de Evacuación 7, Nueva Esperanza.',
      'La evacuación ha terminado. No quedan transportes.',
      'A quienes lleguen tarde: no enciendan luces de noche. No respondan a voces que conozcan.',
      'Diríjanse a la costa. Puerto Alba tenía barcos.',
      '(Grabación añadida, una voz cansada) Si alguien escucha esto… llevamos cuarenta días sin ver el sol de verdad. La ceniza no deja de caer.',
    ],
  },
  {
    id: 'alba', site: 'alba',
    title: 'Diario', from: 'Lucía Varela · pescadora',
    text: [
      'Día 3 después del Silencio. Los barcos no zarparon: el mar está negro de ceniza.',
      'Al principio fue la Luna. Dicen que encontraron algo en la cara que nunca vemos, y que lo despertaron.',
      'Luego llegaron los vigías. Cayeron del cielo como semillas, se clavaron en las plazas y crecieron hasta ser altos como torres.',
      'Pero lo peor no son los vigías. Lo peor llega cuando oscurece.',
      'Lo que queda del ejército se reagrupa en Ciudad Meridiano. Mañana camino hacia allí.',
    ],
  },
  {
    id: 'meridiano', site: 'meridiano',
    title: 'Informe final', from: 'Capitán R. Okafor · 3.ª División',
    text: [
      'Perímetro perdido. Somos once.',
      'Los vigías no nos persiguen. No pueden: están enraizados. Escupen ácido a todo lo que se acerca y vuelven a quedarse quietos, mirando.',
      'Las otras cosas son distintas. No aparecen en los sensores térmicos. Salen de la sombra y vuelven a ella. Y de día cazan los rastreadores, en manada.',
      'Regla número uno: no te alejes de la luz. Nunca he visto a una cruzar un charco de sol.',
      'La doctora Ibarra dice que sabe qué las llama. Está en San Telmo, en el laboratorio de la universidad. San Telmo está del lado de la noche: lleva luz.',
    ],
  },
  {
    id: 'telmo', site: 'telmo',
    title: 'Notas de laboratorio', from: 'Dra. Elena Ibarra · radioastronomía',
    text: [
      'La detectamos hace seis años desde la Base Tsiolkovsky, en la cara oculta de la Luna: una señal repetida, demasiado ordenada para ser natural.',
      'No era un saludo. Era una respuesta. Algo enterrado bajo el cráter llevaba muchísimo tiempo esperando a que alguien escuchara.',
      'Cuando la amplificamos para descifrarla, la señal cambió. Ahora apunta a una estrella: TRAPPIST-1, a cuarenta años luz.',
      'Creo que no la llamamos nosotros. Creo que nos llamó ella, y algo más vino por el mismo camino.',
      'Mandé todos los datos al Observatorio Cumbre, en las montañas. Si alguien puede apagar la señal, que empiece allí.',
    ],
  },
  {
    id: 'cumbre', site: 'cumbre',
    title: 'Última transmisión', from: 'Director T. Halvorsen · Observatorio Cumbre',
    text: [
      'A quien despierte: somos los últimos. La red cayó hace semanas; mantuvimos vivas las naves en órbita mientras pudimos.',
      'Hay pilotos en criosueño. Programamos sus naves para despertarlos cuando la Tierra quedara en silencio. Si escuchas esto, eres uno de ellos.',
      'La señal todavía sale de la Base Tsiolkovsky. Mientras siga emitiendo, ellos seguirán viniendo.',
      'No sé qué encontrarás allí. Sé que no vendrá nadie más.',
      'Ve a la cara oculta de la Luna. Y si puedes evitarlo, no viajes de noche.',
    ],
  },
];

export interface Objective {
  text: string;
  /** ruin site id, or 'tsiolkovsky' (far side of the Moon) */
  place: string;
}

/** the objective after reading `read` recordings in order */
export function objectiveAt(stage: number): Objective {
  switch (stage) {
    case 0: return { text: 'Investiga la baliza de emergencia en las ruinas de Nueva Esperanza', place: 'esperanza' };
    case 1: return { text: 'Busca a los supervivientes en Puerto Alba, en la costa', place: 'alba' };
    case 2: return { text: 'Sigue a Lucía hasta Ciudad Meridiano', place: 'meridiano' };
    case 3: return { text: 'Encuentra el laboratorio de la doctora Ibarra en San Telmo, del lado de la noche', place: 'telmo' };
    case 4: return { text: 'Sube al Observatorio Cumbre, en las montañas', place: 'cumbre' };
    default: return { text: 'Viaja a la cara oculta de la Luna: la Base Tsiolkovsky', place: 'tsiolkovsky' };
  }
}

// ---------------------------------------------------------------------------
// Phase 4: the far side of the Moon and the map of the signal

/** Base Tsiolkovsky: two terminals and the artefact itself (it gives the scanner) */
export const BASE_LOGS: LogEntry[] = [
  {
    id: 'tsio-1', site: 't1',
    title: 'Diario de la base', from: 'Comandante Aiko Mori · Base Tsiolkovsky',
    text: [
      'Día 212. La excavación llegó a los nueve metros. El objeto no es roca: es un material que no refleja nada, y está tibio.',
      'Día 230. Los turnos de noche oyen pasos en el módulo C. El módulo C está vacío desde hace un mes.',
      'Día 241. Pedimos permiso a la Tierra para apagar el amplificador. Nos dijeron que no: que estamos a punto de entenderla.',
      'Día 244. Hay algo fuera, en la oscuridad del cráter. No sale a la luz de los focos. Espera.',
      'Si alguien lee esto: los focos de la excavación se quedan encendidos. Que nadie los apague.',
    ],
  },
  {
    id: 'tsio-2', site: 't2',
    title: 'Registro técnico', from: 'Ingeniero Pavel Dorn · comunicaciones',
    text: [
      'La señal tiene dos partes. Una se repite igual desde hace siglos. La otra cambia cada vez que la escuchamos, como si respondiera.',
      'La parte que cambia dibuja un mapa. Tres puntos encendidos: Marte, Europa y una luz que no es de este sistema, Próxima Centauri.',
      'En cada punto hay algo como lo nuestro: piedra negra, inscripciones. Partes del mismo mensaje.',
      'Unidos, los tres trazan una línea hacia TRAPPIST-1. Hacia un faro.',
      'El artefacto reacciona a los trajes. Si acercas el escáner, se sincroniza. No sé si eso es bueno.',
    ],
  },
  {
    id: 'tsio-3', site: 'artefact',
    title: 'El artefacto', from: 'Lo que registra el escáner del traje',
    text: [
      'Al acercarte, el escáner del traje se enciende solo. Las líneas del objeto brillan un poco más, sin parpadear, como si te miraran.',
      'Una vibración sube por los guantes. En la pantalla aparecen coordenadas: tres puntos, Marte, Europa y Próxima b.',
      'El escáner ahora oye lo que antes no oía: los fragmentos del mapa y otras señales débiles, escondidas.',
      'Por un momento juras que el objeto pronuncia tu nombre.',
    ],
  },
];

/** the three fragments of the map, engraved on the monoliths (read with the scanner) */
export const FRAGMENTS: LogEntry[] = [
  {
    id: 'frag-mars', site: 'frag-mars',
    title: 'Fragmento del mapa · Marte', from: 'Inscripción alienígena · traducción aproximada del escáner',
    text: ['«Llamamos a los que escuchan. Los que escuchan vienen.»', '«Los que vienen no se van.»'],
  },
  {
    id: 'frag-europa', site: 'frag-europa',
    title: 'Fragmento del mapa · Europa', from: 'Inscripción alienígena · traducción aproximada del escáner',
    text: ['«Bajo el hielo esperamos. Bajo la luz no podemos.»', '«La luz es el muro.»'],
  },
  {
    id: 'frag-proxima', site: 'frag-proxima',
    title: 'Fragmento del mapa · Próxima b', from: 'Inscripción alienígena · traducción aproximada del escáner',
    text: ['«El faro está donde el día no se mueve.»', '«Apagadlo, y el camino se cierra.»'],
  },
];

// ---------------------------------------------------------------------------
// Phase 5: secrets, upgrades and the end

export type UpgradeId = 'o2' | 'battery' | 'rifle' | 'armor' | 'engine' | 'cargo' | 'dispersor';
export const UPGRADES: { id: UpgradeId; name: string; desc: string; metal: number; crystal: number }[] = [
  { id: 'o2', name: 'Tanque de oxígeno ampliado', desc: 'El oxígeno del traje dura 10 minutos en vez de 6', metal: 12, crystal: 4 },
  { id: 'battery', name: 'Batería de alta densidad', desc: 'Linterna, arma y extracción gastan un 35% menos', metal: 10, crystal: 6 },
  { id: 'rifle', name: 'Fusil de arco mejorado', desc: 'Tus disparos hacen un 60% más de daño', metal: 14, crystal: 8 },
  { id: 'armor', name: 'Blindaje del traje y del casco', desc: 'Recibes un 35% menos de daño', metal: 20, crystal: 6 },
  { id: 'engine', name: 'Motor de pulso eficiente', desc: 'Los saltos gastan un 30% menos de combustible', metal: 16, crystal: 10 },
  { id: 'cargo', name: 'Bodega del traje', desc: 'Puedes cargar 40 unidades en vez de 24', metal: 8, crystal: 3 },
  { id: 'dispersor', name: 'Dispersor de pulsos', desc: 'Un abanico de pulsos a corta distancia (tecla 2). El ejército guardaba uno en Ciudad Meridiano', metal: 18, crystal: 5 },
];

/** hidden caches: only the scanner hears them (each one holds an upgrade; some, the pilot's own diary) */
export interface CacheDef { id: string; body: string; dir: [number, number, number]; upgrade: UpgradeId; log?: LogEntry }
export const CACHES: CacheDef[] = [
  {
    id: 'cache-phobos', body: 'phobos', dir: [0.6, 0.2, 0.77], upgrade: 'o2',
    log: {
      id: 'pilot-1', site: 'cache-phobos', title: 'Grabación personal (1/3)', from: 'Tu propia voz, antes del criosueño',
      text: [
        'Si estás oyendo esto, soy yo. Tú. Antes de dormir.',
        'Me dijeron que al despertar no recordaría nada: el criosueño largo borra los últimos meses.',
        'Por eso dejo estas notas donde solo yo las buscaría. Siempre quise ver Stickney de cerca.',
        'La siguiente la dejaré donde llueve metano, junto a los lagos de Saturno.',
      ],
    },
  },
  { id: 'cache-io', body: 'io', dir: [0.3, 0.5, -0.81], upgrade: 'armor' },
  {
    id: 'cache-titan', body: 'titan', dir: [-0.5, 0.2, 0.84], upgrade: 'cargo',
    log: {
      id: 'pilot-2', site: 'cache-titan', title: 'Grabación personal (2/3)', from: 'Tu propia voz, antes del criosueño',
      text: [
        'Estuve en Tsiolkovsky. Fui yo quien trajo a la Tierra la primera muestra del artefacto.',
        'No sabíamos que la señal viajaba con ella. Que lo que la escuchaba la seguiría.',
        'Lo que pasó en la Tierra empezó en mi nave.',
        'La última nota estará lejos, en el mundo más frío de TRAPPIST-1. Si llegas hasta allí, ya sabrás por qué.',
      ],
    },
  },
  { id: 'cache-callisto', body: 'callisto', dir: [0.7, -0.3, 0.65], upgrade: 'battery' },
  { id: 'cache-mercury', body: 'mercury', dir: [-0.2, 0.1, 0.97], upgrade: 'engine' },
  {
    id: 'cache-trappist-h', body: 'trappist-1h', dir: [0.4, 0.4, 0.82], upgrade: 'rifle',
    log: {
      id: 'pilot-3', site: 'cache-trappist-h', title: 'Grabación personal (3/3)', from: 'Tu propia voz, antes del criosueño',
      text: [
        'Halvorsen no me eligió por ser buen piloto. Me eligió porque el artefacto me reconoce.',
        'El Guardián de la Aguja no es un monstruo. Es un cerrojo. Mientras el faro arda, él lo protege.',
        'Si llegas hasta él, no luches por odio. Lucha para apagar la llamada. Y luego, descansa.',
      ],
    },
  },
];

/** what the screen says when the Spire falls silent */
export const END_LINES = [
  'LA SEÑAL SE HA APAGADO',
  'El faro de TRAPPIST-1 e se apaga, pulso a pulso, hasta quedar en silencio.',
  'En la Tierra, en la Luna, en Marte… lo que vino por el camino ya no oye la llamada.',
  'Nadie te va a dar las gracias. No queda nadie.',
  'Pero el camino está cerrado. Y el universo, por fin, está en silencio.',
];

// ---------------------------------------------------------------------------
/** a place of the world the map can send you to (a mission point in survival) */
export interface Place {
  id: string;
  name: string;
  /** body id and names of its world and star system */
  body: string;
  world: string;
  system: string;
  desc: string;
  /** survival only: done, the current objective, or still to do */
  status?: 'hecho' | 'objetivo' | 'pendiente';
  /** a real place of the solar system (Olympus Mons, Stickney...) */
  real?: boolean;
  /** survival: optional (a hidden cache the scanner hears, a distress signal) */
  optional?: boolean;
}

/** what the map says about each place (survival: the story's words) */
export const PLACE_INFO: Record<string, string> = {
  esperanza: 'Ciudad en ruinas junto a la costa. Una baliza de la Estación de Evacuación 7 sigue emitiendo en la plaza.',
  alba: 'Puerto en ruinas. Los barcos nunca zarparon.',
  meridiano: 'La última posición del ejército. Dos vigías enraizados guardan la plaza.',
  telmo: 'Ciudad universitaria del lado de la noche. El laboratorio de la doctora Ibarra.',
  cumbre: 'Observatorio de montaña, de noche. Desde aquí se mantuvo con vida a las naves en órbita.',
  tsiolkovsky: 'Base científica en la cara oculta de la Luna, siempre a oscuras. Aquí se desenterró el artefacto.',
  'frag-mars': 'Monolito alienígena en el lado nocturno de Marte: un fragmento del mapa de la señal.',
  'frag-europa': 'Monolito alienígena en el lado nocturno de Europa: un fragmento del mapa de la señal.',
  'frag-proxima': 'Monolito alienígena en la cara helada de Próxima b, a 4,25 años luz: el último fragmento.',
  spire: 'La Aguja: una torre de piedra negra en la noche eterna de TRAPPIST-1 e. El faro de la señal.',
};
/** the same places described for realistic exploration: what they are and why they are worth the trip */
export const PLACE_INFO_EXPLORE: Record<string, string> = {
  esperanza: 'Ciudad en ruinas cerca de la costa, bajo el sol de la mañana. En la plaza sigue en pie un mástil con una luz roja fija.',
  alba: 'Antiguo puerto junto al mar: torres partidas frente al agua.',
  meridiano: 'La ciudad en ruinas más grande: una plaza central abierta rodeada de torres rotas.',
  telmo: 'Ciudad universitaria en el lado nocturno de la Tierra: para verla hace falta la linterna.',
  cumbre: 'Observatorio de montaña, de noche, con su gran antena rota apuntando al cielo.',
  tsiolkovsky: 'Base científica abandonada en la cara oculta de la Luna, siempre a oscuras. Junto a ella asoma un objeto negro.',
  'frag-mars': 'Un monolito negro rodeado de piedras en el lado nocturno de Marte. Sus líneas brillan sin parpadear.',
  'frag-europa': 'Un monolito negro sobre el hielo de Europa, de noche, con Júpiter en el cielo.',
  'frag-proxima': 'Un monolito negro en la cara helada de Próxima b, a 4,25 años luz del Sol.',
  spire: 'Una torre de piedra negra de 170 m en la noche eterna de TRAPPIST-1 e, con un haz de luz violeta hacia el cielo.',
  olympus: 'El volcán más alto del sistema solar: 21,9 km sobre la llanura y 600 km de ancho. Su caldera mide 80 km.',
  tharsis: 'La meseta de Tharsis: un abombamiento volcánico de miles de kilómetros que sostiene a los grandes volcanes de Marte.',
  valles: 'Valles Marineris: un sistema de cañones de 4 000 km de largo y hasta 7 km de profundidad.',
  stickney: 'El cráter Stickney: 9 km de ancho en una luna de solo 22. El golpe que lo hizo casi parte Fobos en dos.',
};

/** real places modelled on the terrain (both modes): body and unit direction from its centre */
export const LANDMARKS: { id: string; name: string; body: string; dir: [number, number, number] }[] = [
  { id: 'olympus', name: 'Monte Olimpo', body: 'mars', dir: [Math.cos(0.3255) * Math.cos(-2.335), Math.sin(0.3255), Math.cos(0.3255) * Math.sin(-2.335)] },
  { id: 'tharsis', name: 'Meseta de Tharsis', body: 'mars', dir: [Math.cos(0.05) * Math.cos(-1.85), Math.sin(0.05), Math.cos(0.05) * Math.sin(-1.85)] },
  { id: 'valles', name: 'Valles Marineris', body: 'mars', dir: [Math.cos(-0.14) * Math.cos(-1.35), Math.sin(-0.14), Math.cos(-0.14) * Math.sin(-1.35)] },
  { id: 'stickney', name: 'Cráter Stickney', body: 'phobos', dir: [0.6, 0.2, 0.77] },
];

/** exploration's optional grand tour, in order */
export const GRAND_TOUR: { id: string; name: string; how: string }[] = [
  { id: 'moon', name: 'Caminar por la Luna', how: 'Baja de la nave en la Luna' },
  { id: 'olympus', name: 'El Monte Olimpo', how: 'Acércate a menos de 60 km de su cumbre, en Marte' },
  { id: 'jupiter', name: 'Bajo las nubes de Júpiter', how: 'Desciende por debajo de sus nubes' },
  { id: 'rings', name: 'Los anillos de Saturno', how: 'Vuela a menos de 1 000 km del plano de los anillos' },
  { id: 'titan', name: 'Los lagos de Titán', how: 'Baja de la nave en Titán' },
  { id: 'proxima-b', name: 'Otra estrella: Próxima b', how: 'Baja de la nave en Próxima b' },
  { id: 'trappist-1e', name: 'TRAPPIST-1 e', how: 'Baja de la nave en TRAPPIST-1 e' },
];

// ---------------------------------------------------------------------------
// More to find: the mementos of humanity (in the supply crates and shelters)

export interface Memento { id: string; name: string; text: string }
export const MEMENTOS: Memento[] = [
  { id: 'm-boda', name: 'Una foto de boda', text: 'Dos personas riéndose bajo la lluvia, con el vestido manchado de barro. Detrás pone: «El mejor día. Aunque se mojara el pastel».' },
  { id: 'm-dibujo', name: 'Un dibujo infantil', text: 'Una Luna enorme pintada con lápiz gris, y debajo una casa con cuatro figuras. Encima, con letra torcida: «Mi papá trabaja allí».' },
  { id: 'm-medalla', name: 'Una medalla de natación', text: 'Segundo puesto, 100 metros libres, categoría infantil. La cinta está gastada de tanto tocarla.' },
  { id: 'm-carta', name: 'Una carta sin enviar', text: '«Mamá: sé que discutimos. Cuando todo esto pase, voy a ir a verte. Te lo prometo.» No tiene sello.' },
  { id: 'm-llaves', name: 'Unas llaves con un pez', text: 'Tres llaves y un llavero de goma con forma de pez payaso. Alguien pensó que volvería a casa.' },
  { id: 'm-receta', name: 'Una receta de familia', text: 'Torta de la abuela Rosa: harina, naranja, mucho cariño. «Si la haces tú, no le pongas tanta azúcar como yo.»' },
  { id: 'm-entrada', name: 'Una entrada de concierto', text: 'Fila 12, asiento 7. El concierto era la semana después del Silencio. Nunca se celebró.' },
  { id: 'm-diario', name: 'Un diario de niña', text: '«Hoy la profe dijo que la Luna nos habla. Yo creo que nos está pidiendo ayuda. Nadie me hace caso.»' },
  { id: 'm-semillas', name: 'Un sobre de semillas', text: 'Girasoles. «Plantar en primavera, al sol.» El sobre sigue cerrado.' },
  { id: 'm-reloj', name: 'Un reloj de bolsillo', text: 'Parado a las 4:12. Grabado en la tapa: «Para que nunca llegues tarde. Te quiere, Elías».' },
  { id: 'm-postal', name: 'Una postal de Marte', text: 'Una foto del monte Olimpo para turistas. «¡Algún día iremos de verdad! Ahorra, ¿eh?»' },
  { id: 'm-osito', name: 'Un osito de peluche', text: 'Le falta un ojo y tiene una venda de tela atada al brazo. Alguien lo curó con cuidado.' },
  { id: 'm-mapa', name: 'Un mapa con rutas marcadas', text: 'Carreteras tachadas en rojo. Un círculo en la costa: «Barcos. Llegar antes del día 10».' },
  { id: 'm-cassette', name: 'Una grabación de voz', text: 'Una voz cansada canta una nana, muy bajito, para que no la oiga lo que espera fuera.' },
  { id: 'm-insignia', name: 'Una insignia de piloto', text: 'Programa de Naves de Criosueño, promoción 41. La misma que llevas en el hombro.' },
  { id: 'm-nota', name: 'Una nota en la pared', text: '«Si lees esto, no estás solo. Aquí estuvimos. Aquí nos quisimos. Que eso cuente.»' },
];

// ---------------------------------------------------------------------------
// VEGA, the ship's computer: it talks to the pilot (dry, a little warm, never chatty)

/** first time on each world */
export const VEGA_LAND: Record<string, string> = {
  earth: 'La Tierra. El aire todavía se respira. Lo demás… mejor no lo midas.',
  moon: 'Sin aire, gravedad un sexto de la terrestre. Salta con cuidado: aquí caer tarda.',
  mars: 'Marte. Polvo fino como harina y frío de verdad. El oxígeno del traje es lo único que tienes.',
  europa: 'Europa. Bajo este hielo hay un océano. Y quizá algo más.',
  'proxima-b': 'Próxima b. Esta estrella escupe radiación cuando se enfada. No te quedes mucho al descubierto.',
  'trappist-1e': 'TRAPPIST-1 e. De aquí sale la llamada. Lo noto en todos mis sistemas.',
  phobos: 'Fobos. Casi no hay gravedad: un salto fuerte y no vuelves a bajar. La mochila también empuja hacia abajo ({KeyC}).',
  deimos: 'Deimos. Aquí un salto tarda minutos en volver. Si te pasas, la mochila empuja hacia abajo ({KeyC}).',
  titan: 'Titán. Lagos de metano y un cielo naranja. Precioso, si no tuvieras que respirar.',
  io: 'Ío. Volcanes de azufre y la radiación de Júpiter. Si el escáner oye algo aquí, que sea rápido.',
  callisto: 'Calisto. Hielo viejo y cráteres sobre cráteres, lejos de lo peor de la radiación de Júpiter.',
  mercury: 'Mercurio. Al sol el traje se cuece; a la sombra se congela. No te quedes quieto.',
  'trappist-1h': 'TRAPPIST-1 h. El mundo más frío de este sistema. Si alguien escondió algo aquí, sabía que nadie vendría a mirar.',
};
/** what the screen says when a creature or a danger kills the pilot */
export const DEATH: Record<string, string> = {
  stalker: 'Un acechador salió de la oscuridad. No lo viste llegar.',
  swarm: 'El enjambre te cubrió. Eran demasiados.',
  colossus: 'El coloso te alcanzó. La luz solo lo frenaba.',
  spitter: 'El ácido de un escupidor te alcanzó desde lejos.',
  tracker: 'Los rastreadores te rodearon a plena luz. Cazan en manada.',
  sentinel: 'El ácido de un vigía te alcanzó. Nada se acerca a su plaza y sale entero.',
  guardian: 'El Guardián de la Aguja te alcanzó. El faro sigue ardiendo.',
  hunter: 'Las mantarrayas del vacío destrozaron la nave.',
  dark: 'Algo salió de la oscuridad. No lo viste llegar.',
  day: 'Algo te alcanzó. No lo viste llegar.',
};
export const VEGA = {
  first: 'Estoy contigo por radio, piloto. Si me necesitas, aquí estaré. Aunque no tenga a dónde ir.',
  zone: 'Movimiento en la oscuridad, cerca. Ten la linterna a mano.',
  sentinel: 'Un vigía. Está enraizado: no te seguirá, pero escupe ácido. Muévete de lado para esquivarlo.',
  stalker: 'Eso que viste… se acerca cuando no lo miras. No le des la espalda.',
  swarm: 'Un enjambre. Pequeños pero muchos. El dispersor sería ideal aquí.',
  spitter: 'Escupe desde lejos. Acércate rápido o busca dónde cubrirte.',
  colossus: 'Eso es enorme. La luz no lo detiene, solo lo frena. Dispara y retrocede.',
  colossusDown: 'Lo has tumbado. Ni yo misma me lo creo.',
  tracker: 'Rastreadores. Cazan en manada y a plena luz: la linterna no los asusta. No dejes que te rodeen.',
  hunters: 'Algo vivo se acerca a la nave por el vacío. Como mantarrayas. Cañones listos: {Mouse0} para disparar.',
  huntersRespawn: 'Sube por encima de 2.500 km: no nos siguen tan alto. O salta con {KeyJ} en cuanto salgamos de su zona.',
  ambushSpace: '¡Nos han seguido! Mantarrayas del vacío detrás de nosotros.',
  lowO2: 'Te queda poco oxígeno. Vuelve a la nave, por favor.',
  lowBattery: 'La batería del traje está casi vacía. Sin ella no hay linterna ni disparos.',
  lowHealth: 'Tus constantes caen. Si llevas un botiquín, úsalo ya ({KeyB}).',
  noMedkit: 'No te quedan botiquines. Busca cajas de suministros en las ruinas.',
  revive: 'Te traje de vuelta. Otra vez. Intenta que no se convierta en costumbre.',
  crate: 'Suministros. Alguien los dejó para quien viniera después.',
  memento: 'Esto era de alguien. Lo guardaré en tu colección.',
  bunker: 'Un refugio. Aquí aguantaron un tiempo. No sé cuánto.',
  dispersor: 'El dispersor de pulsos del ejército. A corta distancia no perdona. Cámbialo con {WeaponToggle}.',
  ambushRuins: '¡Cuidado! No estábamos solos.',
  signal: 'Capto una señal de socorro automática. Te la marco en el mapa: el círculo ○.',
  signalGone: 'La señal de socorro se ha apagado.',
  wreck: 'Es una nave como la nuestra. Estrellada. Revisa los restos: quizá quede algo útil.',
  idle: 'Si te pierdes, abre el mapa ({KeyM}). En MISIONES tienes el siguiente paso.',
  guardian: 'Esa bestia es el cerrojo del faro. Los pilones alimentan su escudo.',
  end: 'Se ha ido. La señal ya no está. Por primera vez en años… silencio.',
  airborne: 'Llevas un minuto en el aire. Aquí la gravedad casi no tira: empuja la mochila hacia abajo con {KeyC}.',
  recall: 'Si no puedes volver, pulsa {KeyE}: llevo la nave hasta ti.',
  swim: 'Estás en el agua. El traje flota, pero nadar con él es lento. Busca la orilla.',
  noFuelUnsafe: 'Ahí no hay hielo que sacar, o el lugar te mataría antes. Te llevo al mundo más cercano donde sí lo hay.',
  noFuelFar: 'Con este combustible no llegamos: nos quedaríamos a medio camino. La reserva aguanta, pero el casco sufre.',
  crafted: 'Hecho. No es bonito, pero funciona.',
  beacon: 'Una baliza de luz fija. Mientras arda, lo que vive en la oscuridad no se acercará.',
  lamp: 'La linterna te protege de cerca… pero de lejos te delata. Lo decía la baliza: nada de luces de noche.',
  notMe: 'Eso que acabas de leer… no era yo. Yo no he dicho nada.',
  pylonGlow: 'El pilón caído deja energía en el aire. Acércate: recarga el traje.',
  heart: '¡Su corazón! Después de cada ráfaga baja la cabeza: dispara entonces.',
  phase2: 'Está llamando a los suyos. Vienen escupidores.',
  phase3: 'Algo enorme sale de la oscuridad. Aguanta.',
  marsStones: 'La inscripción está repartida: tres piedras del anillo tienen las líneas apagadas. Ilumínalas con la linterna.',
  europaIce: 'El hielo cubre la inscripción. Extráelo, pero rápido: la radiación de Júpiter no espera.',
  proximaScan: 'Quédate cerca mientras el escáner traduce. Y prepárate: esto los va a atraer.',
  epilogue: 'Todavía tienes el sobre de semillas. Nueva Esperanza tiene sol. Creo que sé lo que quieres hacer.',
  planted: 'Girasoles. En la Tierra, otra vez. Quizá alguien vuelva algún día y los vea.',
  radiation: 'Aquí la radiación te quita salud: tienes unos {MIN} minutos fuera de la nave.',
  suborbital: 'Vuelo suborbital: subo por encima del aire, cruzo y te dejo junto al punto.',
} as const;
/** VEGA on the way, during a suborbital flight to a place of the story (once each) */
export const VEGA_HOP: Record<string, string> = {
  alba: 'Puerto Alba. Desde aquí arriba se ve el puerto: los barcos siguen amarrados.',
  meridiano: 'Ciudad Meridiano. La plaza está despejada, pero no vacía. Mejor aterriza a un lado.',
  telmo: 'San Telmo está en la noche. Enciende la linterna al bajar… y apágala si oyes algo a lo lejos.',
  cumbre: 'El observatorio está en la cima. Allí arriba el aire es fino y hace frío.',
  esperanza: 'Nueva Esperanza. La baliza sigue llamando. Vamos a ver quién la dejó encendida.',
};
/** what speaks in VEGA's voice in the deep dark, when it is not VEGA */
export const FAKE_VOICES = [
  'Piloto… apaga la linterna. Ven hacia mí. Te espero aquí.',
  'Sal de la luz. Aquí no hay nada. Confía en mí.',
  'La nave está por aquí. Sigue mi voz.',
  'No mires atrás. Camina hacia la oscuridad.',
];
/** crafted aboard with what is in the hold */
export type CraftId = 'medkit' | 'beacon';
export const CRAFTS: { id: CraftId; name: string; desc: string; metal: number; crystal: number }[] = [
  { id: 'medkit', name: 'Botiquín', desc: '+45 de salud al usarlo (puedes llevar 5)', metal: 2, crystal: 2 },
  { id: 'beacon', name: 'Baliza de luz', desc: 'Se clava en el suelo y aleja a las criaturas durante 2 minutos (puedes llevar 3)', metal: 3, crystal: 1 },
];
/** the epilogue at Nueva Esperanza */
export const EPILOGUE: LogEntry = {
  id: 'epilogue', site: 'esperanza', title: 'Girasoles', from: 'Nueva Esperanza · después de la señal',
  text: [
    'Abres el sobre. Las semillas son pequeñas, rayadas, y huelen a algo que habías olvidado.',
    'Las entierras junto a la baliza, donde da el sol toda la mañana. La tierra está seca, pero no muerta.',
    'VEGA no dice nada durante un rato. Luego, muy bajito: «Gracias por traerme hasta aquí».',
    'El sol sigue en el mismo sitio de siempre. Ahora, por fin, alumbra algo nuevo.',
  ],
};
/** what VEGA thinks after each recording */
export const VEGA_STORY: Record<string, string> = {
  beacon: 'No respondan a voces que conozcan… Si alguna vez te hablo raro, desconfía de mí.',
  alba: '"Lo peor llega cuando oscurece." Anotado. Prefiero el lado del día.',
  meridiano: 'Los vigías no se mueven y las sombras huyen de la luz. Ya tenemos dos reglas. Los rastreadores, ninguna.',
  telmo: 'TRAPPIST-1, a cuarenta años luz. Tenemos combustible para eso… si lo cuidas.',
  cumbre: 'Eres uno de los pilotos que despertaron. Supongo que eso me hace tu única compañía.',
  'tsio-1': 'Los focos de la excavación siguen encendidos. Alguien cumplió su palabra.',
  'tsio-2': 'Marte, Europa y Próxima. Un mapa repartido por las estrellas. Qué poco práctico.',
  'tsio-3': 'Tu escáner y yo ahora oímos lo mismo que el artefacto. No me gusta cómo suena.',
  'frag-mars': 'Uno de tres. "Los que vienen no se van." Encantador.',
  'frag-europa': '"La luz es el muro." Eso explica muchas cosas.',
  'frag-proxima': 'El mapa está completo. Rumbo a TRAPPIST-1 e. Esto se acaba allí, de un modo u otro.',
  'pilot-1': 'Esa voz es la tuya. No sabía que dejaste notas. No me lo contaste.',
  'pilot-2': 'Así que empezó contigo. No es culpa tuya. Bueno… no solo tuya.',
  'pilot-3': 'Un cerrojo, no un monstruo. Haz lo que tengas que hacer, piloto.',
};

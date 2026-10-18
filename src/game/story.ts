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
      'Luego llegaron las máquinas. Bajaron del cielo sin hacer ruido y apagaron las ciudades, una por una.',
      'Pero lo peor no son las máquinas. Lo peor llega cuando oscurece.',
      'Lo que queda del ejército se reagrupa en Ciudad Meridiano. Mañana camino hacia allí.',
    ],
  },
  {
    id: 'meridiano', site: 'meridiano',
    title: 'Informe final', from: 'Capitán R. Okafor · 3.ª División',
    text: [
      'Perímetro perdido. Somos once.',
      'Las máquinas no nos persiguen. Vigilan. Disparan a lo que se acerca a sus torres y vuelven a quedarse quietas.',
      'Las otras cosas son distintas. No aparecen en los sensores térmicos. Salen de la sombra y vuelven a ella.',
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

export type UpgradeId = 'o2' | 'battery' | 'rifle' | 'armor' | 'engine' | 'cargo';
export const UPGRADES: { id: UpgradeId; name: string; desc: string; metal: number; crystal: number }[] = [
  { id: 'o2', name: 'Tanque de oxígeno ampliado', desc: 'El oxígeno del traje dura 10 minutos en vez de 6', metal: 12, crystal: 4 },
  { id: 'battery', name: 'Batería de alta densidad', desc: 'Linterna, arma y extracción gastan un 35% menos', metal: 10, crystal: 6 },
  { id: 'rifle', name: 'Fusil de arco mejorado', desc: 'Tus disparos hacen un 60% más de daño', metal: 14, crystal: 8 },
  { id: 'armor', name: 'Blindaje del traje y del casco', desc: 'Recibes un 35% menos de daño', metal: 20, crystal: 6 },
  { id: 'engine', name: 'Motor de pulso eficiente', desc: 'Los saltos gastan un 30% menos de combustible', metal: 16, crystal: 10 },
  { id: 'cargo', name: 'Bodega del traje', desc: 'Puedes cargar 40 unidades en vez de 24', metal: 8, crystal: 3 },
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

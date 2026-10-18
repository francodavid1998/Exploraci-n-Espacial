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
      'La doctora Ibarra dice que sabe qué las llama. Está en San Telmo, en el laboratorio de la universidad.',
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
    case 3: return { text: 'Encuentra el laboratorio de la doctora Ibarra en San Telmo', place: 'telmo' };
    case 4: return { text: 'Sube al Observatorio Cumbre, en las montañas', place: 'cumbre' };
    default: return { text: 'Viaja a la cara oculta de la Luna: la Base Tsiolkovsky', place: 'tsiolkovsky' };
  }
}

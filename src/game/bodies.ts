import { Noise3, craterField, smoothstep, clamp, lerp } from './noise';

export const AU = 1.495978707e11;
export const C_LIGHT = 299792458;
export const LY = 9.4607304725808e15; // light-year in metres
const DEG = Math.PI / 180;

/** Star appearance and physics (one per `kind: 'star'` body). */
export interface StarDef {
  luminosity: number; // in solar luminosities (sets how bright planets are lit)
  teff: number; // effective temperature, K
  colorLimb: [number, number, number]; // disc shader colour at the limb
  colorCenter: [number, number, number]; // disc shader colour at the centre
  glowStops: [number, number, number][]; // four RGB stops (0-255) for the halo texture
  glowTint: [number, number, number]; // halo sprite tint
  lightTint: [number, number, number]; // colour of the light cast on planets
  intensity: number; // disc brightness (keep low for red stars or tone mapping bleaches them white)
  glowIntensity: number; // halo sprite brightness
}
/** The Sun seen from space is white (G2V, 5 778 K); it only looks yellow or red through an atmosphere. */
export const SUN_STAR: StarDef = {
  luminosity: 1, teff: 5778,
  colorLimb: [1.0, 0.8, 0.55], colorCenter: [1.0, 0.97, 0.92],
  glowStops: [[255, 250, 242], [255, 240, 222], [255, 226, 196], [255, 212, 172]],
  glowTint: [1, 0.97, 0.92], lightTint: [1, 1, 1], intensity: 40, glowIntensity: 2.2,
};
/** Proxima Centauri: M5.5Ve red dwarf (Teff ≈ 3 040 K, L ≈ 0.15 % L☉, Ribas et al. 2017). */
export const PROXIMA_STAR: StarDef = {
  luminosity: 0.00151, teff: 3042,
  colorLimb: [0.55, 0.08, 0.02], colorCenter: [1.0, 0.32, 0.1],
  glowStops: [[255, 120, 70], [240, 70, 30], [200, 40, 12], [150, 25, 8]],
  glowTint: [1, 0.3, 0.12], lightTint: [1, 0.72, 0.55], intensity: 4, glowIntensity: 1.1,
};

export type BodyKind = 'star' | 'rocky' | 'gas';

export interface AtmoDef {
  height: number; // m
  betaR: [number, number, number]; // per meter
  betaM: number;
  HR: number;
  HM: number;
  g: number;
  sun: number; // scattering intensity
  mieTint: [number, number, number];
  fogColor: [number, number, number];
  fogDensity: number; // per meter at surface
  surfaceDensity: number; // relative to earth
  skyBrightness: number;
}

export interface CloudDef {
  alt: number; // m above surface
  color: [number, number, number];
  coverage: number;
  opacity: number;
  type: number; // 0 earth, 1 venus, 2 titan
  thickness: number; // m (fog layer)
}

export interface BodyDef {
  id: string;
  name: string;
  kind: BodyKind;
  radius: number;
  parent?: string;
  /** distance to the parent (m); for a top-level body, distance to the Sun */
  orbit: number;
  /** orbital angle (rad); for a top-level body, ecliptic longitude measured from +X towards +Z */
  angle: number;
  incl?: number;
  /** ecliptic latitude (rad) of a top-level body (+Y = ecliptic north); used to place other stars */
  lat?: number;
  /** star appearance/physics (kind 'star' only; defaults to the Sun) */
  star?: StarDef;
  gravity: number;
  tempC: number;
  tempText: string;
  pressure: number; // bar at surface (gas: 1 at cloud tops)
  composition: string;
  description: string;
  facts: string[];
  tilt: number;
  scaleHeight: number; // m
  atmo?: AtmoDef;
  clouds?: CloudDef;
  gasType?: number;
  rings?: number; // 0 saturn 1 uranus 2 neptune
  hazard?: { suitDrain: number; text: string };
  markerColor: string;
  seed: number;
}

export const BODIES: BodyDef[] = [
  {
    id: 'sun', name: 'Sol', kind: 'star', radius: 696340e3, orbit: 0, angle: 0, gravity: 274, tempC: 5500,
    tempText: '5 500 °C (fotosfera) · 15 millones °C (núcleo)', pressure: 0, composition: 'Hidrógeno 73% · Helio 25%',
    description: 'Estrella enana amarilla de tipo G2V. Contiene el 99,86% de la masa del sistema solar.',
    facts: ['Edad: ~4 600 millones de años', 'La luz tarda 8 min 20 s en llegar a la Tierra', 'Diámetro: 109 veces el de la Tierra'],
    tilt: 0.126, scaleHeight: 1, markerColor: '#ffd36b', seed: 1, star: SUN_STAR,
  },
  {
    id: 'mercury', name: 'Mercurio', kind: 'rocky', radius: 2439.7e3, orbit: 0.387 * AU, angle: 0.55, gravity: 3.7, tempC: 167,
    tempText: '−173 °C (noche) a 427 °C (día)', pressure: 0, composition: 'Exosfera casi nula (O, Na, H, He, K)',
    description: 'El planeta más pequeño y cercano al Sol. Superficie antigua saturada de cráteres, sin atmósfera real.',
    facts: ['Un día solar dura 176 días terrestres', 'Núcleo de hierro enorme (~85% del radio)', 'Escarpes lobulados por contracción del planeta'],
    tilt: 0, scaleHeight: 1, markerColor: '#b7aca2', seed: 11,
    hazard: { suitDrain: 0.6, text: 'Radiación solar y temperatura extremas' },
  },
  {
    id: 'venus', name: 'Venus', kind: 'rocky', radius: 6051.8e3, orbit: 0.723 * AU, angle: 2.25, gravity: 8.87, tempC: 464,
    tempText: '464 °C en superficie', pressure: 92, composition: 'CO₂ 96,5% · N₂ 3,5% · nubes de ácido sulfúrico',
    description: 'Efecto invernadero desbocado. Presión 92 veces la terrestre, nubes de ácido sulfúrico entre 48 y 70 km.',
    facts: ['El planeta más caliente del sistema solar', 'Rota al revés y muy lento (243 días)', 'Las sondas Venera sobrevivieron solo minutos en la superficie'],
    tilt: 0, scaleHeight: 15800, markerColor: '#e8c98a', seed: 22,
    atmo: { height: 250e3, betaR: [2.2e-5, 1.6e-5, 0.7e-5], betaM: 2.5e-5, HR: 15800, HM: 12000, g: 0.7, sun: 18, mieTint: [1, 0.85, 0.6], fogColor: [0.55, 0.36, 0.16], fogDensity: 6e-5, surfaceDensity: 60, skyBrightness: 1 },
    clouds: { alt: 70e3, color: [1.0, 0.92, 0.72], coverage: -0.6, opacity: 1, type: 1, thickness: 22e3 },
    hazard: { suitDrain: 6, text: '92 bar y 464 °C: el traje no resistirá' },
  },
  {
    id: 'earth', name: 'Tierra', kind: 'rocky', radius: 6371e3, orbit: 1.0 * AU, angle: 0, gravity: 9.81, tempC: 15,
    tempText: '−89 °C a 57 °C (media 15 °C)', pressure: 1, composition: 'N₂ 78% · O₂ 21% · Ar 0,9%',
    description: 'Nuestro hogar. El único mundo conocido con agua líquida en superficie y vida.',
    facts: ['71% de la superficie cubierta por océanos', 'Campo magnético que protege del viento solar', 'Edad: ~4 540 millones de años'],
    tilt: 0, scaleHeight: 8500, markerColor: '#6fb7ff', seed: 33,
    atmo: { height: 100e3, betaR: [5.5e-6, 13.0e-6, 22.4e-6], betaM: 21e-6, HR: 8000, HM: 1200, g: 0.76, sun: 22, mieTint: [1, 1, 1], fogColor: [0.55, 0.68, 0.85], fogDensity: 1.6e-5, surfaceDensity: 1, skyBrightness: 1 },
    clouds: { alt: 6e3, color: [1, 1, 1], coverage: 0.05, opacity: 0.95, type: 0, thickness: 1500 },
  },
  {
    id: 'moon', name: 'Luna', kind: 'rocky', radius: 1737.4e3, parent: 'earth', orbit: 384400e3, angle: 2.35, incl: 0.09, gravity: 1.62, tempC: -20,
    tempText: '−173 °C (noche) a 127 °C (día)', pressure: 0, composition: 'Sin atmósfera (exosfera de He, Ar, Na)',
    description: 'El único satélite natural de la Tierra. Mares de basalto oscuro y tierras altas cubiertas de cráteres.',
    facts: ['12 humanos la han pisado (Apolo 1969-1972)', 'Siempre muestra la misma cara a la Tierra', 'Se aleja 3,8 cm por año'],
    tilt: 0, scaleHeight: 1, markerColor: '#d9d9d9', seed: 44,
  },
  {
    id: 'mars', name: 'Marte', kind: 'rocky', radius: 3389.5e3, orbit: 1.524 * AU, angle: 0.95, gravity: 3.71, tempC: -63,
    tempText: '−125 °C a 20 °C (media −63 °C)', pressure: 0.006, composition: 'CO₂ 95% · N₂ 2,8% · Ar 2%',
    description: 'El planeta rojo. Óxido de hierro, el volcán más alto del sistema solar y casquetes polares de hielo.',
    facts: ['Monte Olimpo: 21,9 km de altura', 'Valles Marineris: 4 000 km de largo', 'Los atardeceres marcianos son azules'],
    tilt: 0, scaleHeight: 11100, markerColor: '#ff7b4a', seed: 55,
    atmo: { height: 110e3, betaR: [9e-6, 5.6e-6, 3.2e-6], betaM: 6e-6, HR: 11100, HM: 9000, g: 0.8, sun: 20, mieTint: [0.75, 0.8, 1.0], fogColor: [0.7, 0.5, 0.35], fogDensity: 8e-6, surfaceDensity: 0.02, skyBrightness: 0.6 },
    hazard: { suitDrain: 0, text: '' },
  },
  {
    id: 'phobos', name: 'Fobos', kind: 'rocky', radius: 11.27e3, parent: 'mars', orbit: 9376e3, angle: 1.2, gravity: 0.0057, tempC: -40,
    tempText: '−112 °C a −4 °C', pressure: 0, composition: 'Sin atmósfera',
    description: 'Luna irregular de Marte, probablemente un asteroide capturado. Dominada por el cráter Stickney.',
    facts: ['Orbita Marte 3 veces al día', 'Caerá sobre Marte en ~50 millones de años', 'Un salto puede casi escapar de su gravedad'],
    tilt: 0, scaleHeight: 1, markerColor: '#a59a8f', seed: 66,
  },
  {
    id: 'deimos', name: 'Deimos', kind: 'rocky', radius: 6.2e3, parent: 'mars', orbit: 23463e3, angle: 4.0, gravity: 0.003, tempC: -40,
    tempText: '≈ −40 °C', pressure: 0, composition: 'Sin atmósfera',
    description: 'La luna más pequeña de Marte, cubierta de regolito suave.',
    facts: ['Período orbital: 30,3 horas', 'Velocidad de escape: 5,6 m/s', 'Descubierta en 1877'],
    tilt: 0, scaleHeight: 1, markerColor: '#b5a99c', seed: 77,
  },
  {
    id: 'jupiter', name: 'Júpiter', kind: 'gas', radius: 69911e3, orbit: 5.203 * AU, angle: -0.6, gravity: 24.79, tempC: -110,
    tempText: '−110 °C en las nubes · aumenta con la profundidad', pressure: 1, composition: 'H₂ 90% · He 10% · CH₄, NH₃',
    description: 'El gigante gaseoso. No tiene superficie: la presión y la temperatura aumentan hasta aplastar cualquier nave.',
    facts: ['La Gran Mancha Roja es más grande que la Tierra', 'La sonda Galileo dejó de transmitir a ~23 bar', 'Hidrógeno metálico en su interior'],
    tilt: 0.054, scaleHeight: 27000, markerColor: '#e0b98a', seed: 88, gasType: 0,
    atmo: { height: 600e3, betaR: [3.0e-6, 3.6e-6, 4.8e-6], betaM: 2e-6, HR: 27000, HM: 20000, g: 0.7, sun: 14, mieTint: [1, 0.95, 0.85], fogColor: [0.7, 0.58, 0.44], fogDensity: 0, surfaceDensity: 1, skyBrightness: 0.6 },
  },
  {
    id: 'io', name: 'Ío', kind: 'rocky', radius: 1821.6e3, parent: 'jupiter', orbit: 421700e3, angle: 0.3, gravity: 1.796, tempC: -143,
    tempText: '−143 °C (lagos de lava a 1 600 °C)', pressure: 0, composition: 'SO₂ muy tenue',
    description: 'El cuerpo con más actividad volcánica del sistema solar, calentado por las mareas de Júpiter.',
    facts: ['Más de 400 volcanes activos', 'Penachos de azufre de hasta 500 km', 'Radiación letal del cinturón de Júpiter'],
    tilt: 0, scaleHeight: 1, markerColor: '#f2dd6b', seed: 99,
    hazard: { suitDrain: 1.2, text: 'Radiación intensa de Júpiter (36 Sv/día)' },
  },
  {
    id: 'europa', name: 'Europa', kind: 'rocky', radius: 1560.8e3, parent: 'jupiter', orbit: 671034e3, angle: 2.1, gravity: 1.315, tempC: -160,
    tempText: '−220 °C a −160 °C', pressure: 0, composition: 'O₂ extremadamente tenue',
    description: 'Corteza de hielo surcada de grietas sobre un océano global de agua salada.',
    facts: ['Superficie más lisa del sistema solar', 'Océano con el doble de agua que la Tierra', 'Las líneas rojizas son sales y azufre'],
    tilt: 0, scaleHeight: 1, markerColor: '#e8e2d4', seed: 111,
    hazard: { suitDrain: 0.5, text: 'Radiación de Júpiter (5,4 Sv/día)' },
  },
  {
    id: 'ganymede', name: 'Ganímedes', kind: 'rocky', radius: 2634.1e3, parent: 'jupiter', orbit: 1070412e3, angle: 3.6, gravity: 1.428, tempC: -160,
    tempText: '−203 °C a −121 °C', pressure: 0, composition: 'O₂ extremadamente tenue',
    description: 'La luna más grande del sistema solar, mayor que Mercurio. Terrenos oscuros antiguos y surcos brillantes.',
    facts: ['Única luna con campo magnético propio', 'Probable océano subterráneo', 'Diámetro: 5 268 km'],
    tilt: 0, scaleHeight: 1, markerColor: '#bdb2a3', seed: 122,
  },
  {
    id: 'callisto', name: 'Calisto', kind: 'rocky', radius: 2410.3e3, parent: 'jupiter', orbit: 1882709e3, angle: 5.1, gravity: 1.235, tempC: -139,
    tempText: '−193 °C a −108 °C', pressure: 0, composition: 'CO₂ muy tenue',
    description: 'La superficie más craterizada del sistema solar. Oscura, antigua y geológicamente muerta.',
    facts: ['Cuenca de impacto Valhalla: 3 800 km', 'Fuera del cinturón de radiación intenso', 'Superficie de ~4 000 millones de años'],
    tilt: 0, scaleHeight: 1, markerColor: '#8f8273', seed: 133,
  },
  {
    id: 'saturn', name: 'Saturno', kind: 'gas', radius: 58232e3, orbit: 9.537 * AU, angle: 2.55, gravity: 10.44, tempC: -140,
    tempText: '−140 °C en las nubes', pressure: 1, composition: 'H₂ 96% · He 3% · CH₄',
    description: 'El señor de los anillos. Gigante gaseoso menos denso que el agua, sin superficie sólida.',
    facts: ['Anillos de hielo de 280 000 km y solo ~10 m de grosor', 'Vientos de 1 800 km/h', 'Hexágono permanente en el polo norte'],
    tilt: 0.466, scaleHeight: 59500, markerColor: '#f0d9a0', seed: 144, gasType: 1, rings: 0,
    atmo: { height: 700e3, betaR: [3.4e-6, 3.6e-6, 4.0e-6], betaM: 2e-6, HR: 59500, HM: 40000, g: 0.7, sun: 14, mieTint: [1, 0.95, 0.85], fogColor: [0.8, 0.7, 0.5], fogDensity: 0, surfaceDensity: 1, skyBrightness: 0.6 },
  },
  {
    id: 'titan', name: 'Titán', kind: 'rocky', radius: 2574.7e3, parent: 'saturn', orbit: 1221870e3, angle: 1.0, gravity: 1.352, tempC: -179,
    tempText: '−179 °C', pressure: 1.45, composition: 'N₂ 95% · CH₄ 5%',
    description: 'Atmósfera densa y anaranjada, dunas de hidrocarburos y lagos de metano líquido.',
    facts: ['Único lugar además de la Tierra con líquidos estables en superficie', 'La sonda Huygens aterrizó en 2005', 'Llueve metano'],
    tilt: 0, scaleHeight: 40000, markerColor: '#e3a64d', seed: 155,
    atmo: { height: 500e3, betaR: [1.2e-5, 0.62e-5, 0.18e-5], betaM: 1.1e-5, HR: 40000, HM: 30000, g: 0.65, sun: 18, mieTint: [1, 0.7, 0.35], fogColor: [0.55, 0.36, 0.16], fogDensity: 5e-5, surfaceDensity: 5, skyBrightness: 0.8 },
    clouds: { alt: 160e3, color: [0.95, 0.62, 0.28], coverage: -0.5, opacity: 0.9, type: 2, thickness: 60e3 },
    hazard: { suitDrain: 0.15, text: 'Frío extremo: −179 °C' },
  },
  {
    id: 'uranus', name: 'Urano', kind: 'gas', radius: 25362e3, orbit: 19.19 * AU, angle: -2.0, gravity: 8.69, tempC: -195,
    tempText: '−195 °C (mínimo del sistema solar: −224 °C)', pressure: 1, composition: 'H₂ 83% · He 15% · CH₄ 2,3%',
    description: 'Gigante de hielo que gira tumbado de lado (98°). El metano le da su color cian.',
    facts: ['Cada polo tiene 42 años de luz y 42 de oscuridad', '13 anillos tenues y oscuros', 'Solo visitado por la Voyager 2 (1986)'],
    tilt: 1.707, scaleHeight: 27700, markerColor: '#9fe6ec', seed: 166, gasType: 2, rings: 1,
    atmo: { height: 400e3, betaR: [2.0e-6, 5.0e-6, 6.0e-6], betaM: 1e-6, HR: 27700, HM: 20000, g: 0.7, sun: 14, mieTint: [0.8, 1, 1], fogColor: [0.5, 0.75, 0.8], fogDensity: 0, surfaceDensity: 1, skyBrightness: 0.6 },
  },
  {
    id: 'neptune', name: 'Neptuno', kind: 'gas', radius: 24622e3, orbit: 30.07 * AU, angle: 1.6, gravity: 11.15, tempC: -201,
    tempText: '−201 °C en las nubes', pressure: 1, composition: 'H₂ 80% · He 19% · CH₄ 1,5%',
    description: 'El planeta más lejano. Azul intenso y los vientos más rápidos del sistema solar.',
    facts: ['Vientos de hasta 2 100 km/h', 'La luz del Sol tarda 4 horas en llegar', 'Descubierto por cálculo matemático en 1846'],
    tilt: 0.494, scaleHeight: 19700, markerColor: '#5d7dff', seed: 177, gasType: 3, rings: 2,
    atmo: { height: 400e3, betaR: [1.2e-6, 3.6e-6, 9.0e-6], betaM: 1e-6, HR: 19700, HM: 15000, g: 0.7, sun: 14, mieTint: [0.8, 0.9, 1], fogColor: [0.3, 0.45, 0.9], fogDensity: 0, surfaceDensity: 1, skyBrightness: 0.6 },
  },
  {
    id: 'triton', name: 'Tritón', kind: 'rocky', radius: 1353.4e3, parent: 'neptune', orbit: 354759e3, angle: 2.7, incl: 0.4, gravity: 0.779, tempC: -235,
    tempText: '−235 °C', pressure: 0.000014, composition: 'N₂ extremadamente tenue',
    description: 'Luna con órbita retrógrada, probablemente capturada del cinturón de Kuiper. Géiseres de nitrógeno.',
    facts: ['Una de las superficies más frías conocidas', 'Terreno "piel de melón" único', 'Géiseres de nitrógeno de 8 km de altura'],
    tilt: 0, scaleHeight: 1, markerColor: '#e8c9c0', seed: 188,
    hazard: { suitDrain: 0.2, text: 'Frío extremo: −235 °C' },
  },
  // -------------------------------------------------------------------------
  // Proxima Centauri system. Position from RA 14h29m43s, Dec −62°40′46″ (J2000)
  // converted to ecliptic coordinates: longitude 239.1°, latitude −44.8°.
  // -------------------------------------------------------------------------
  {
    id: 'proxima', name: 'Próxima Centauri', kind: 'star', radius: 0.1542 * 696340e3, orbit: 4.2465 * LY, angle: 239.12 * DEG, lat: -44.76 * DEG,
    gravity: 1407, tempC: 2769, tempText: '≈ 2 800 °C (fotosfera) · enana roja M5.5V', pressure: 0, composition: 'Hidrógeno ~70% · Helio ~28% · elementos pesados',
    description: 'La estrella más cercana al Sol: una enana roja tenue con el 12% de la masa solar y el 15% de su radio, que emite solo el 0,15% de su luz. Es una estrella fulgurante: sus erupciones multiplican su brillo en minutos y bañan a sus planetas en rayos X.',
    facts: ['Distancia: 4,2465 años luz (1,30 pc)', 'Descubierta en 1915 por Robert Innes', 'Forma parte del sistema triple Alfa Centauri: orbita a las estrellas A y B a ~13 000 UA', 'Temperatura superficial ≈ 3 040 K · rotación ≈ 83 días', 'Vivirá billones de años: las enanas rojas queman su hidrógeno muy despacio'],
    tilt: 0, scaleHeight: 1, markerColor: '#ff7a55', seed: 300, star: PROXIMA_STAR,
  },
  {
    id: 'proxima-d', name: 'Próxima Centauri d', kind: 'rocky', radius: 0.7 * 6371e3, parent: 'proxima', orbit: 0.02885 * AU, angle: 0.8, gravity: 5.3, tempC: 87,
    tempText: '≈ 87 °C de equilibrio · lado diurno mucho más caliente', pressure: 0, composition: 'Sin atmósfera conocida (probablemente arrasada por las fulguraciones)',
    description: 'Subtierra confirmada en 2022 con el espectrógrafo ESPRESSO del VLT: al menos un cuarto de la masa terrestre, orbitando a solo 0,029 UA cada 5,1 días. Su radio y composición se desconocen; se representa como un mundo rocoso árido y abrasado.',
    facts: ['Masa mínima: 0,26 masas terrestres', 'Período orbital: 5,12 días', 'Recibe casi el doble de luz que la Tierra', 'Uno de los planetas más ligeros detectados por velocidad radial', 'Probablemente en rotación síncrona'],
    tilt: 0, scaleHeight: 1, markerColor: '#d9a07a', seed: 301,
    hazard: { suitDrain: 1.0, text: 'Calor y radiación de las fulguraciones de Próxima' },
  },
  {
    id: 'proxima-b', name: 'Próxima Centauri b', kind: 'rocky', radius: 1.02 * 6371e3, parent: 'proxima', orbit: 0.04856 * AU, angle: 2.9, gravity: 10.1, tempC: -39,
    tempText: '≈ −39 °C de equilibrio (sin efecto invernadero)', pressure: 0.3, composition: 'Desconocida · aquí: N₂ y CO₂ tenues (hipotética)',
    description: 'El exoplaneta confirmado más cercano a la Tierra (2016, HARPS/ESO): masa mínima de 1,07 Tierras en la zona habitable de Próxima. Casi con seguridad en rotación síncrona, con un hemisferio en día perpetuo y otro en noche eterna. Si conserva atmósfera y agua sería un "mundo ojo": océano templado frente a la estrella y hielo en la cara oculta. Así se representa aquí.',
    facts: ['Masa mínima: 1,07 masas terrestres', 'Período orbital: 11,19 días a 0,0486 UA', 'Recibe el 65% de la luz que la Tierra recibe del Sol', 'Las fulguraciones de Próxima bañan su superficie en rayos X y ultravioleta', 'Objetivo del proyecto Breakthrough Starshot'],
    tilt: 0, scaleHeight: 9000, markerColor: '#7fb8a8', seed: 302,
    atmo: { height: 60e3, betaR: [7e-6, 9e-6, 14e-6], betaM: 8e-6, HR: 9000, HM: 1500, g: 0.76, sun: 20, mieTint: [1, 0.9, 0.8], fogColor: [0.6, 0.55, 0.5], fogDensity: 8e-6, surfaceDensity: 0.3, skyBrightness: 0.6 },
    hazard: { suitDrain: 0.3, text: 'Radiación de las fulguraciones de Próxima' },
  },
  {
    id: 'proxima-c', name: 'Próxima Centauri c', kind: 'gas', radius: 2.4 * 6371e3, parent: 'proxima', orbit: 1.489 * AU, angle: 4.4, gravity: 11.9, tempC: -234,
    tempText: '≈ −234 °C en las nubes', pressure: 1, composition: 'Hipotética: H₂, He y metano (minineptuno)',
    description: 'Candidato sin confirmar (2020, Damasso et al.): una supertierra o minineptuno de al menos 7 masas terrestres a 1,5 UA, con un año de 5,3 años terrestres. Análisis posteriores lo ponen en duda. Se representa como un minineptuno helado con un posible anillo de polvo.',
    facts: ['Masa mínima: ≈ 7 masas terrestres (sin confirmar)', 'Período orbital: 1 928 días', 'Recibe menos del 0,1% de la luz que recibe la Tierra', 'El Hubble detectó un posible exceso de luz: ¿anillos o polvo?'],
    tilt: 0.3, scaleHeight: 18000, markerColor: '#8fa8ff', seed: 303, gasType: 3, rings: 2,
    atmo: { height: 150e3, betaR: [1.2e-6, 3.6e-6, 9.0e-6], betaM: 1e-6, HR: 18000, HM: 14000, g: 0.7, sun: 14, mieTint: [0.8, 0.9, 1], fogColor: [0.3, 0.45, 0.9], fogDensity: 0, surfaceDensity: 1, skyBrightness: 0.6 },
  },
];

// ---------------------------------------------------------------------------
// Terrain generators
// ---------------------------------------------------------------------------

export interface TerrainGen {
  height(x: number, y: number, z: number, minWl: number): number;
  color(x: number, y: number, z: number, h: number, slope: number, out: Float32Array, i: number): void;
  seaLevel: number | null;
  rocks(h: number, slope: number): number; // density per m²
  rockScale: number;
  trees?: (x: number, y: number, z: number, h: number, slope: number) => number;
  waterDeep?: [number, number, number];
  waterShallow?: [number, number, number];
}

function put(out: Float32Array, i: number, r: number, g: number, b: number) {
  // perceptual -> linear (approx gamma 2.2)
  out[i * 3] = Math.pow(clamp(r, 0, 1), 2.2);
  out[i * 3 + 1] = Math.pow(clamp(g, 0, 1), 2.2);
  out[i * 3 + 2] = Math.pow(clamp(b, 0, 1), 2.2);
}
type C3 = [number, number, number];
function mix3(a: C3, b: C3, t: number): C3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

interface CrateredOpts {
  maria: number;
  craterDensity: number;
  craterDepth: number;
  hill: number;
  high: C3;
  mare: C3;
  rough: number;
  brightPeaks?: number;
  grooves?: number;
  irregular?: number;
  stickney?: boolean;
  minCraterCell?: number;
}

function cratered(R: number, seed: number, o: CrateredOpts): TerrainGen {
  const n1 = new Noise3(seed), n2 = new Noise3(seed + 1), n3 = new Noise3(seed + 2), n4 = new Noise3(seed + 3);
  const stick = [0.6, 0.2, 0.77];
  const sl = Math.hypot(stick[0], stick[1], stick[2]);
  const mareMask = (px: number, py: number, pz: number, minWl: number) => {
    if (o.maria <= 0) return 0;
    const mv = n2.fbm(px, py, pz, R * 1.1, 5, Math.max(minWl, R * 0.004));
    return smoothstep(0.45 - o.maria, 0.6 - o.maria, mv);
  };
  const grooveMask = (px: number, py: number, pz: number) =>
    o.grooves ? smoothstep(-0.05, 0.2, n4.fbm(px, py, pz, R * 0.5, 4, R * 0.01)) : 0;
  return {
    seaLevel: null,
    rockScale: R < 50e3 ? 0.6 : 1,
    height(x, y, z, minWl) {
      const px = x * R, py = y * R, pz = z * R;
      const mare = mareMask(px, py, pz, minWl);
      let h = n1.fbm(px, py, pz, R * 0.3, 14, minWl) * o.hill * (1 - 0.75 * mare);
      h += n3.ridged(px, py, pz, R * 0.07, 9, minWl) * o.hill * 0.6 * (1 - mare);
      h -= mare * o.hill * 0.9;
      h += craterField(px, py, pz, seed, R * 0.6, o.minCraterCell ?? 5, o.craterDensity, o.craterDepth * (1 - 0.55 * mare), minWl);
      if (o.grooves) {
        const gm = grooveMask(px, py, pz);
        if (gm > 0) {
          const warp = n2.noise(px / 30000, py / 30000, pz / 30000) * 8;
          h += gm * o.grooves * Math.sin((px * 0.62 + py * 0.31 + pz * 0.72) / 2200 + warp);
        }
      }
      if (o.irregular) h += n4.fbm(px, py, pz, R * 0.7, 4, minWl) * R * o.irregular;
      if (o.stickney) {
        const d = Math.acos(clamp((x * stick[0] + y * stick[1] + z * stick[2]) / sl, -1, 1)) * R;
        const r = 4500;
        if (d < r * 1.7) h += (d / r < 1.7 ? (d * d) / (r * r) - 1 : 0) * 900 * (d < r ? 1 : smoothstep(r * 1.7, r, d));
      }
      h += n1.fbm(px, py, pz, 45, 5, minWl) * o.rough;
      h += n2.fbm(px, py, pz, 3, 3, minWl) * 0.22;
      return h;
    },
    color(x, y, z, h, slope, out, i) {
      const px = x * R, py = y * R, pz = z * R;
      const mare = mareMask(px, py, pz, R * 0.004);
      let c = mix3(o.high, o.mare, mare);
      const v = n3.fbm(px, py, pz, R * 0.05, 5, R * 0.0008) * 0.12 + n1.noise(px / 900, py / 900, pz / 900) * 0.04;
      if (o.grooves) {
        const gm = grooveMask(px, py, pz);
        c = mix3(c, [c[0] * 1.6, c[1] * 1.6, c[2] * 1.6], gm);
      }
      let b = 1 + v - slope * 0.25;
      if (o.brightPeaks) b += smoothstep(0, o.hill * 1.5, h) * o.brightPeaks;
      put(out, i, c[0] * b, c[1] * b, c[2] * b);
    },
    rocks: (_h, slope) => 0.012 + slope * 0.06,
  };
}

function marsGen(R: number, seed: number): TerrainGen {
  const n1 = new Noise3(seed), n2 = new Noise3(seed + 1), n3 = new Noise3(seed + 2), n4 = new Noise3(seed + 3);
  // Olympus Mons ~ 18.65N, 226.2E
  const olat = 0.3255, olon = -2.335;
  const oD = [Math.cos(olat) * Math.cos(olon), Math.sin(olat), Math.cos(olat) * Math.sin(olon)];
  const tD = [Math.cos(0.05) * Math.cos(-1.85), Math.sin(0.05), Math.cos(0.05) * Math.sin(-1.85)];
  return {
    seaLevel: null,
    rockScale: 1,
    height(x, y, z, minWl) {
      const px = x * R, py = y * R, pz = z * R;
      const dich = smoothstep(-0.25, 0.3, y * 0.9 + n4.fbm(px, py, pz, R * 0.9, 4, minWl) * 0.45);
      let h = 1500 - dich * 3800;
      h += n1.fbm(px, py, pz, R * 0.3, 14, minWl) * 2000;
      h += n3.ridged(px, py, pz, R * 0.06, 9, minWl) * 1700 * (1 - dich);
      h += craterField(px, py, pz, seed, R * 0.45, 6, 0.42, 0.7 * (1 - 0.5 * dich), minWl);
      // Tharsis bulge
      const dt = Math.acos(clamp(x * tD[0] + y * tD[1] + z * tD[2], -1, 1));
      h += 4500 * Math.exp(-(dt * dt) / 0.18);
      // Olympus Mons
      const dO = Math.acos(clamp(x * oD[0] + y * oD[1] + z * oD[2], -1, 1)) * R;
      if (dO < 380e3) {
        const f = clamp(1 - dO / 320e3, 0, 1);
        const cone = Math.pow(f, 1.6) * 19000 + smoothstep(0, 0.06, f) * 3000;
        let cal = 0;
        if (dO < 45e3) cal = -3000 * smoothstep(45e3, 30e3, dO);
        h += (cone + cal) * smoothstep(380e3, 300e3, dO);
      }
      // Valles Marineris
      const lon = Math.atan2(z, x), lat = Math.asin(clamp(y, -1, 1));
      if (lon > -1.8 && lon < -0.9) {
        const latC = -0.14 + 0.025 * Math.sin(lon * 9) + n2.fbm(px, py, pz, 200e3, 3, minWl) * 0.012;
        const W = 0.018 + 0.01 * n2.noise(px / 300e3, py / 300e3, pz / 300e3);
        const d = Math.abs(lat - latC) / W;
        const taper = smoothstep(-1.8, -1.65, lon) * smoothstep(-0.9, -1.05, lon);
        if (d < 1.6) h -= 6500 * (1 - smoothstep(0.55, 1.5, d)) * taper;
      }
      // dunes + detail
      h += n2.ridged(px * 1.4, py, pz, 600, 3, minWl) * 25 * dich;
      h += n1.fbm(px, py, pz, 300, 7, minWl) * 18;
      h += n2.fbm(px, py, pz, 3, 3, minWl) * 0.25;
      return h;
    },
    color(x, y, z, h, slope, out, i) {
      const px = x * R, py = y * R, pz = z * R;
      const d = n1.fbm(px, py, pz, R * 0.12, 6, R * 0.001);
      const dark = smoothstep(0.05, 0.4, d);
      let c: C3 = mix3([0.72, 0.4, 0.22], [0.36, 0.22, 0.15], dark);
      c = mix3(c, [0.82, 0.55, 0.36], smoothstep(4000, 15000, h) * 0.6);
      c = mix3(c, [0.42, 0.27, 0.2], smoothstep(0.2, 0.55, slope));
      const v = 1 + n3.noise(px / 700, py / 700, pz / 700) * 0.06;
      const cap = smoothstep(0.9, 0.95, Math.abs(y) + n2.noise(px / 150e3, py / 150e3, pz / 150e3) * 0.03);
      c = mix3(c, [0.95, 0.93, 0.9], cap);
      put(out, i, c[0] * v, c[1] * v, c[2] * v);
    },
    rocks: (_h, slope) => 0.03 + slope * 0.05,
  };
}

function venusGen(R: number, seed: number): TerrainGen {
  const n1 = new Noise3(seed), n2 = new Noise3(seed + 1), n3 = new Noise3(seed + 2);
  return {
    seaLevel: null,
    rockScale: 1,
    height(x, y, z, minWl) {
      const px = x * R, py = y * R, pz = z * R;
      let h = n1.fbm(px, py, pz, R * 0.35, 14, minWl) * 1700;
      const hl = smoothstep(0.15, 0.6, n2.fbm(px, py, pz, R * 0.6, 3, minWl));
      h += n3.ridged(px, py, pz, R * 0.1, 9, minWl) * 3000 * hl;
      h += craterField(px, py, pz, seed, R * 0.12, 3000, 0.12, 0.45, minWl); // atmosphere filters small impactors
      h += n2.ridged(px, py, pz, 4000, 5, minWl) * 60 * (1 - hl);
      h += n1.fbm(px, py, pz, 200, 6, minWl) * 12;
      h += n2.fbm(px, py, pz, 3, 3, minWl) * 0.25;
      return h;
    },
    color(x, y, z, h, slope, out, i) {
      const px = x * R, py = y * R, pz = z * R;
      const t = smoothstep(-0.2, 0.4, n1.fbm(px, py, pz, R * 0.08, 5, R * 0.002));
      let c: C3 = mix3([0.3, 0.26, 0.22], [0.48, 0.4, 0.3], t);
      c = mix3(c, [0.22, 0.2, 0.18], smoothstep(0.25, 0.6, slope));
      c = mix3(c, [0.55, 0.5, 0.45], smoothstep(2000, 6000, h) * 0.5);
      put(out, i, c[0], c[1], c[2]);
    },
    rocks: () => 0.05,
  };
}

function earthGen(R: number, seed: number): TerrainGen {
  const n1 = new Noise3(seed), n2 = new Noise3(seed + 1), n3 = new Noise3(seed + 2), n4 = new Noise3(seed + 3), n5 = new Noise3(seed + 4);
  const cont = (px: number, py: number, pz: number, minWl: number) => {
    const w = Math.max(minWl, 20e3);
    const wx = n4.fbm(px, py, pz, R * 0.7, 3, w) * R * 0.22;
    const wy = n5.fbm(px, py, pz, R * 0.7, 3, w) * R * 0.22;
    return n1.fbm(px + wx, py + wy, pz - wx, R * 0.6, 9, Math.max(minWl, 2000)) - 0.12;
  };
  const temp = (y: number, h: number, px: number, py: number, pz: number) =>
    1 - Math.abs(y) * 1.12 - Math.max(h, 0) / 4200 + n3.fbm(px, py, pz, R * 0.12, 3, 50e3) * 0.18;
  const moist = (px: number, py: number, pz: number) => n2.fbm(px, py, pz, R * 0.18, 5, 5000) * 0.6 + 0.5;
  return {
    seaLevel: 0,
    rockScale: 1,
    waterDeep: [0.01, 0.06, 0.12],
    waterShallow: [0.05, 0.32, 0.35],
    height(x, y, z, minWl) {
      const px = x * R, py = y * R, pz = z * R;
      const c = cont(px, py, pz, minWl);
      let h: number;
      const hills = n2.fbm(px, py, pz, 30e3, 12, minWl) * 320;
      if (c > 0) {
        h = c * 1500 + hills * smoothstep(0, 0.06, c);
        const mm = smoothstep(0.06, 0.32, c) * smoothstep(-0.1, 0.4, n3.fbm(px, py, pz, R * 0.3, 3, minWl) + 0.15);
        if (mm > 0) {
          const r = n3.ridged(px, py, pz, R * 0.05, 11, minWl);
          h += r * r * 6000 * mm;
        }
      } else {
        h = -160 * smoothstep(0, 0.025, -c) - Math.max(0, -c - 0.025) * 9000 + hills * 0.3 * smoothstep(0.05, 0, -c);
      }
      h += n1.fbm(px, py, pz, 60, 6, minWl) * 1.8;
      h += n2.fbm(px, py, pz, 3, 3, minWl) * 0.18;
      return h;
    },
    color(x, y, z, h, slope, out, i) {
      const px = x * R, py = y * R, pz = z * R;
      const nv = n5.noise(px / 2000, py / 2000, pz / 2000) * 0.05 + n4.noise(px / 150, py / 150, pz / 150) * 0.04;
      let c: C3;
      if (h < 0) {
        c = mix3([0.62, 0.56, 0.4], [0.18, 0.2, 0.18], smoothstep(0, 80, -h));
      } else if (h < 4 + nv * 40) {
        c = [0.78, 0.71, 0.52];
      } else {
        const t = temp(y, h, px, py, pz);
        const m = moist(px, py, pz);
        const grass: C3 = [0.3, 0.42, 0.15];
        const forest: C3 = [0.11, 0.24, 0.07];
        const desert: C3 = [0.76, 0.62, 0.42];
        const taiga: C3 = [0.15, 0.23, 0.13];
        const tundra: C3 = [0.44, 0.41, 0.33];
        c = mix3(grass, forest, smoothstep(0.45, 0.65, m));
        c = mix3(c, desert, smoothstep(0.45, 0.62, t) * smoothstep(0.45, 0.3, m));
        c = mix3(c, taiga, smoothstep(0.4, 0.25, t));
        c = mix3(c, tundra, smoothstep(0.22, 0.1, t));
        c = mix3(c, [0.4, 0.37, 0.33], smoothstep(0.3, 0.55, slope));
        c = mix3(c, [0.95, 0.96, 0.98], smoothstep(0.08, -0.02, t) * (1 - smoothstep(0.55, 0.8, slope)));
      }
      const v = 1 + nv;
      put(out, i, c[0] * v, c[1] * v, c[2] * v);
    },
    rocks: (h, slope) => (h > 5 ? 0.002 + smoothstep(0.25, 0.6, slope) * 0.03 : 0),
    trees(x, y, z, h, slope) {
      if (h < 6 || slope > 0.35) return 0;
      const px = x * R, py = y * R, pz = z * R;
      const t = temp(y, h, px, py, pz);
      const m = moist(px, py, pz);
      if (t < 0.12) return 0;
      const d = smoothstep(0.42, 0.62, m) * (1 - smoothstep(0.45, 0.62, t) * smoothstep(0.45, 0.3, m));
      return d * 0.004 * (0.5 + 0.5 * n4.noise(px / 300, py / 300, pz / 300) + 0.3) + 0.00008;
    },
  };
}

function ioGen(R: number, seed: number): TerrainGen {
  const n1 = new Noise3(seed), n2 = new Noise3(seed + 1), n3 = new Noise3(seed + 2);
  return {
    seaLevel: null,
    rockScale: 1,
    height(x, y, z, minWl) {
      const px = x * R, py = y * R, pz = z * R;
      let h = n1.fbm(px, py, pz, R * 0.3, 14, minWl) * 800;
      const mm = smoothstep(0.35, 0.6, n2.fbm(px, py, pz, R * 0.25, 4, minWl));
      h += n3.ridged(px, py, pz, R * 0.04, 8, minWl) * 8000 * mm;
      h += craterField(px, py, pz, seed, R * 0.12, 2000, 0.18, -0.35, minWl); // paterae
      h += n2.fbm(px, py, pz, 150, 6, minWl) * 6;
      h += n1.fbm(px, py, pz, 3, 3, minWl) * 0.2;
      return h;
    },
    color(x, y, z, h, slope, out, i) {
      const px = x * R, py = y * R, pz = z * R;
      const a = n1.fbm(px, py, pz, R * 0.15, 6, R * 0.001);
      const b = n2.fbm(px, py, pz, R * 0.05, 5, R * 0.001);
      let c: C3 = mix3([0.88, 0.8, 0.38], [0.92, 0.9, 0.76], smoothstep(-0.2, 0.3, a));
      c = mix3(c, [0.82, 0.52, 0.2], smoothstep(0.2, 0.5, b));
      c = mix3(c, [0.5, 0.22, 0.1], smoothstep(0.45, 0.65, b) * 0.8);
      const lava = smoothstep(0.62, 0.7, n3.fbm(px, py, pz, R * 0.03, 4, R * 0.0005));
      c = mix3(c, [0.08, 0.07, 0.06], lava);
      c = mix3(c, [0.55, 0.45, 0.3], smoothstep(0.3, 0.6, slope));
      void h;
      put(out, i, c[0], c[1], c[2]);
    },
    rocks: () => 0.01,
  };
}

function europaGen(R: number, seed: number): TerrainGen {
  const n1 = new Noise3(seed), n2 = new Noise3(seed + 1), n3 = new Noise3(seed + 2), n4 = new Noise3(seed + 3);
  const lines = (px: number, py: number, pz: number, minWl: number) => {
    let m = 0;
    const ns = [n2, n3, n4];
    for (let k = 0; k < 3; k++) {
      const wl = R * (0.25 / (k + 1));
      if (wl * 0.02 < minWl * 0.5) continue;
      const v = 1 - Math.abs(ns[k].fbm(px, py, pz, wl, 3, Math.max(minWl, wl * 0.05)));
      m = Math.max(m, smoothstep(0.955, 0.995, v));
    }
    return m;
  };
  return {
    seaLevel: null,
    rockScale: 0.7,
    height(x, y, z, minWl) {
      const px = x * R, py = y * R, pz = z * R;
      let h = n1.fbm(px, py, pz, R * 0.3, 13, minWl) * 250;
      h += lines(px, py, pz, minWl) * 180;
      h += n2.ridged(px, py, pz, 8000, 6, minWl) * 120 * smoothstep(0.3, 0.6, n3.fbm(px, py, pz, R * 0.2, 3, minWl));
      h += craterField(px, py, pz, seed, R * 0.08, 800, 0.08, 0.25, minWl);
      h += n1.fbm(px, py, pz, 4, 3, minWl) * 0.15;
      return h;
    },
    color(x, y, z, h, slope, out, i) {
      const px = x * R, py = y * R, pz = z * R;
      const l = lines(px, py, pz, 2000);
      const chaos = smoothstep(0.3, 0.6, n3.fbm(px, py, pz, R * 0.2, 3, R * 0.01));
      let c: C3 = [0.86, 0.87, 0.88];
      c = mix3(c, [0.75, 0.62, 0.48], chaos * 0.7);
      c = mix3(c, [0.58, 0.38, 0.24], l);
      const v = 1 + n1.noise(px / 500, py / 500, pz / 500) * 0.04 - slope * 0.15;
      void h;
      put(out, i, c[0] * v, c[1] * v, c[2] * v);
    },
    rocks: () => 0.004,
  };
}

function titanGen(R: number, seed: number): TerrainGen {
  const n1 = new Noise3(seed), n2 = new Noise3(seed + 1), n3 = new Noise3(seed + 2);
  return {
    seaLevel: 0,
    rockScale: 0.7,
    waterDeep: [0.03, 0.02, 0.01],
    waterShallow: [0.12, 0.08, 0.04],
    height(x, y, z, minWl) {
      const px = x * R, py = y * R, pz = z * R;
      let h = 350 + n1.fbm(px, py, pz, R * 0.3, 13, minWl) * 550;
      h += n3.ridged(px, py, pz, R * 0.06, 8, minWl) * 900 * smoothstep(0.2, 0.5, n2.fbm(px, py, pz, R * 0.3, 3, minWl));
      h -= smoothstep(0.7, 0.92, Math.abs(y) * (y > 0 ? 1 : 0.92)) * 700;
      const dm = smoothstep(0.55, 0.2, Math.abs(y));
      if (dm > 0 && minWl < 600) {
        const s = Math.sin((px * 0.8 + pz * 0.6) / 1300 + n2.fbm(px, py, pz, 15000, 3, 500) * 5);
        h += Math.pow(1 - Math.abs(s), 2) * 110 * dm * Math.min(1, 600 / minWl - 1);
      }
      h += craterField(px, py, pz, seed, R * 0.1, 3000, 0.05, 0.4, minWl);
      h += n1.fbm(px, py, pz, 80, 5, minWl) * 3;
      h += n2.fbm(px, py, pz, 3, 3, minWl) * 0.15;
      return h;
    },
    color(x, y, z, h, slope, out, i) {
      const px = x * R, py = y * R, pz = z * R;
      const dm = smoothstep(0.55, 0.2, Math.abs(y));
      let c: C3 = mix3([0.58, 0.44, 0.27], [0.27, 0.19, 0.11], dm * smoothstep(-0.3, 0.2, n1.fbm(px, py, pz, R * 0.1, 4, R * 0.003)));
      c = mix3(c, [0.2, 0.15, 0.1], smoothstep(30, 0, h));
      c = mix3(c, [0.42, 0.33, 0.22], smoothstep(0.3, 0.6, slope));
      put(out, i, c[0], c[1], c[2]);
    },
    rocks: (h) => (h > 2 ? 0.01 : 0),
  };
}

function tritonGen(R: number, seed: number): TerrainGen {
  const n1 = new Noise3(seed), n2 = new Noise3(seed + 1), n3 = new Noise3(seed + 2);
  return {
    seaLevel: null,
    rockScale: 0.8,
    height(x, y, z, minWl) {
      const px = x * R, py = y * R, pz = z * R;
      let h = n1.fbm(px, py, pz, R * 0.3, 13, minWl) * 400;
      const cant = smoothstep(-0.2, 0.2, y + n2.fbm(px, py, pz, R * 0.3, 3, minWl) * 0.3);
      h += -Math.abs(n3.fbm(px, py, pz, 25000, 5, minWl)) * 450 * cant;
      h += craterField(px, py, pz, seed, R * 0.1, 1500, 0.1, 0.4, minWl);
      h += n1.fbm(px, py, pz, 4, 3, minWl) * 0.15;
      return h;
    },
    color(x, y, z, h, slope, out, i) {
      const px = x * R, py = y * R, pz = z * R;
      const cap = smoothstep(-0.1, -0.35, y + n2.noise(px / 200e3, py / 200e3, pz / 200e3) * 0.08);
      let c: C3 = mix3([0.72, 0.62, 0.58], [0.9, 0.84, 0.8], cap);
      const streak = smoothstep(0.55, 0.75, n3.fbm(px * 3, py, pz, R * 0.05, 4, R * 0.002)) * cap;
      c = mix3(c, [0.35, 0.3, 0.3], streak * 0.6);
      const v = 1 + n1.noise(px / 800, py / 800, pz / 800) * 0.05 - slope * 0.2;
      void h;
      put(out, i, c[0] * v, c[1] * v, c[2] * v);
    },
    rocks: () => 0.005,
  };
}

/**
 * Tidally locked temperate world ("eyeball planet"): ocean and bare rock on the
 * day side, a permanent ice sheet on the night side. `sub` is the unit vector
 * towards the star in planet-local coordinates (the substellar point).
 */
function eyeballGen(R: number, seed: number, sub: [number, number, number]): TerrainGen {
  const n1 = new Noise3(seed), n2 = new Noise3(seed + 1), n3 = new Noise3(seed + 2), n4 = new Noise3(seed + 3);
  const day = (x: number, y: number, z: number) => x * sub[0] + y * sub[1] + z * sub[2];
  const iceMask = (x: number, y: number, z: number, px: number, py: number, pz: number) =>
    smoothstep(0.15, -0.15, day(x, y, z) + n4.fbm(px, py, pz, R * 0.2, 3, 20e3) * 0.12);
  return {
    seaLevel: 0,
    rockScale: 1,
    waterDeep: [0.02, 0.07, 0.14],
    waterShallow: [0.05, 0.3, 0.36],
    height(x, y, z, minWl) {
      const px = x * R, py = y * R, pz = z * R;
      const c = n1.fbm(px, py, pz, R * 0.5, 8, Math.max(minWl, 1500)) - 0.05;
      let h: number;
      if (c > 0) {
        h = c * 2200 + n2.fbm(px, py, pz, 25e3, 10, minWl) * 350 * smoothstep(0, 0.05, c);
        const r = n3.ridged(px, py, pz, R * 0.04, 9, minWl);
        h += r * r * 2500 * smoothstep(0.05, 0.3, c);
      } else {
        h = -200 * smoothstep(0, 0.03, -c) - Math.max(0, -c - 0.03) * 6000;
      }
      h += craterField(px, py, pz, seed, R * 0.3, 6, 0.25, 0.5, minWl) * 0.5;
      h += n1.fbm(px, py, pz, 50, 5, minWl) * 1.5 + n2.fbm(px, py, pz, 3, 3, minWl) * 0.2;
      // night side: the ocean freezes into a shelf and land carries an ice sheet
      const ice = iceMask(x, y, z, px, py, pz);
      if (ice > 0) h = Math.max(h, 0) + ice * (150 + n2.fbm(px, py, pz, 8e3, 6, minWl) * 80);
      return h;
    },
    color(x, y, z, h, slope, out, i) {
      const px = x * R, py = y * R, pz = z * R;
      const d = day(x, y, z);
      const ice = iceMask(x, y, z, px, py, pz);
      const v = 1 + n1.noise(px / 700, py / 700, pz / 700) * 0.06;
      let c: C3;
      if (h < 0) c = mix3([0.5, 0.45, 0.35], [0.2, 0.22, 0.2], smoothstep(0, 60, -h));
      else if (h < 3) c = [0.6, 0.55, 0.45];
      else {
        c = mix3([0.45, 0.33, 0.24], [0.3, 0.25, 0.22], smoothstep(-0.3, 0.3, n3.fbm(px, py, pz, R * 0.1, 4, R * 0.003)));
        c = mix3(c, [0.28, 0.22, 0.18], smoothstep(0.5, 0.9, d) * 0.5); // scorched basalt near the substellar point
        c = mix3(c, [0.5, 0.47, 0.44], smoothstep(0.3, 0.6, slope));
      }
      c = mix3(c, [0.88, 0.92, 0.97], ice * (1 - smoothstep(0.55, 0.85, slope)));
      put(out, i, c[0] * v, c[1] * v, c[2] * v);
    },
    rocks: (h, slope) => (h > 3 ? 0.004 + smoothstep(0.25, 0.6, slope) * 0.03 : 0),
  };
}

export function makeGenerator(def: BodyDef): TerrainGen | null {
  const R = def.radius, s = def.seed;
  switch (def.id) {
    case 'proxima-d':
      return cratered(R, s, { maria: 0.08, craterDensity: 0.55, craterDepth: 0.9, hill: 1200, high: [0.42, 0.36, 0.3], mare: [0.3, 0.25, 0.2], rough: 2 });
    case 'proxima-b': {
      // substellar direction in planet-local coordinates (the star sits at -orbit direction)
      const a = def.angle, inc = def.incl ?? 0;
      return eyeballGen(R, s, [-Math.cos(a), -Math.sin(a) * Math.sin(inc), -Math.sin(a) * Math.cos(inc)]);
    }
    case 'mercury':
      return cratered(R, s, { maria: 0.12, craterDensity: 0.62, craterDepth: 1, hill: 1500, high: [0.5, 0.47, 0.44], mare: [0.58, 0.55, 0.5], rough: 2 });
    case 'venus': return venusGen(R, s);
    case 'earth': return earthGen(R, s);
    case 'moon':
      return cratered(R, s, { maria: 0.32, craterDensity: 0.56, craterDepth: 1, hill: 1800, high: [0.58, 0.57, 0.55], mare: [0.27, 0.27, 0.28], rough: 2 });
    case 'mars': return marsGen(R, s);
    case 'phobos':
      return cratered(R, s, { maria: 0, craterDensity: 0.7, craterDepth: 0.8, hill: 300, high: [0.27, 0.25, 0.23], mare: [0.27, 0.25, 0.23], rough: 1.5, irregular: 0.12, stickney: true, minCraterCell: 4 });
    case 'deimos':
      return cratered(R, s, { maria: 0, craterDensity: 0.45, craterDepth: 0.5, hill: 150, high: [0.33, 0.3, 0.27], mare: [0.33, 0.3, 0.27], rough: 0.8, irregular: 0.1, minCraterCell: 4 });
    case 'io': return ioGen(R, s);
    case 'europa': return europaGen(R, s);
    case 'ganymede':
      return cratered(R, s, { maria: 0, craterDensity: 0.42, craterDepth: 0.6, hill: 900, high: [0.38, 0.35, 0.31], mare: [0.38, 0.35, 0.31], rough: 1.5, grooves: 220 });
    case 'callisto':
      return cratered(R, s, { maria: 0, craterDensity: 0.8, craterDepth: 0.7, hill: 1000, high: [0.3, 0.27, 0.24], mare: [0.3, 0.27, 0.24], rough: 1.5, brightPeaks: 0.8 });
    case 'titan': return titanGen(R, s);
    case 'triton': return tritonGen(R, s);
  }
  return null;
}

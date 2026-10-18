// Terrain chunk builder running off the main thread. Each message asks for one
// chunk of one body; the generator for that body is created here on first use
// from the shared body definitions, so nothing but a few numbers crosses the
// thread boundary on the way in, and transferable arrays on the way out.
import { BODIES, makeGenerator, type TerrainGen } from './bodies';
import { buildChunkData, chunkTransferables, type ChunkRequest } from './terrainBuild';

const gens = new Map<string, { gen: TerrainGen; R: number }>();

self.onmessage = (e: MessageEvent<ChunkRequest & { id: number }>) => {
  const req = e.data;
  let entry = gens.get(req.bodyId);
  if (!entry) {
    const def = BODIES.find((b) => b.id === req.bodyId);
    const gen = def ? makeGenerator(def) : null;
    if (!def || !gen) { (self as unknown as Worker).postMessage({ id: req.id, error: `no generator for ${req.bodyId}` }); return; }
    entry = { gen, R: def.radius };
    gens.set(req.bodyId, entry);
  }
  // Always answer: an exception here would otherwise leak one in-flight slot in
  // the pool for the rest of the session and slowly strangle terrain streaming.
  try {
    const data = buildChunkData(entry.gen, entry.R, req);
    (self as unknown as Worker).postMessage({ id: req.id, data }, chunkTransferables(data));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: req.id, error: `${req.bodyId} L${req.level}: ${(err as Error).message ?? err}` });
  }
};

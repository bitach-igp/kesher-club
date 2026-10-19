// @kesher/simulators entry point (T-0009): `node --experimental-strip-types apps/simulators/src/index.ts`
// (or `pnpm --filter @kesher/simulators start`). Refuses to boot outside local/preview/test.
import { loadConfig, defineConfig } from '@kesher/domain';
import { z } from 'zod';
import { SimulatorHost } from './host.ts';
import { createServer } from './server.ts';
import { pathToFileURL } from 'node:url';

export { SimulatorHost, SIM_PROVIDER } from './host.ts';
export type { Simulators, Hook, Fixture } from './host.ts';
export { createServer, handle } from './server.ts';

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = loadConfig(defineConfig({ SIMULATOR_PORT: z.coerce.number().int().min(1).max(65535) }), process.env);
  if (!['development', 'test', 'preview'].includes(config.NODE_ENV)) {
    throw new Error(`Simulators do not run in ${config.NODE_ENV} (constitution art. 6)`);
  }
  const host = new SimulatorHost();
  createServer(host).listen(config.SIMULATOR_PORT, () => console.log(`simulators: control panel on http://localhost:${config.SIMULATOR_PORT}/`));
}

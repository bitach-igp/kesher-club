// Metro for the member app (T-0033): Expo's defaults, plus the monorepo root so the workspace packages
// (@kesher/sdk, @kesher/domain, @kesher/ports/seeded, …) resolve through pnpm's links. They ship TypeScript
// sources with explicit `.ts` imports, which Metro transforms like the app's own files.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { getDefaultConfig } = require('expo/metro-config');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const config = getDefaultConfig(here);
config.watchFolders = [root];
config.resolver.nodeModulesPaths = [path.resolve(here, 'node_modules'), path.resolve(root, 'node_modules')];
// Tests sit next to their screens under app/; expo-router would take them for routes and pull vitest in.
config.resolver.blockList = [...[config.resolver.blockList ?? []].flat(), /\.test\.[jt]sx?$/];

export default config;

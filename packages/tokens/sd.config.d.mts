// Hand-written types for sd.config.mjs so src/*.test.ts can import the build without `allowJs`.
import type { Config, DesignTokens, PreprocessedTokens } from 'style-dictionary/types';

export declare const TOKENS_FILE: string;
export declare const MODES: readonly ['light', 'dark'];
export type Mode = (typeof MODES)[number];

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}
export declare function parseHex(hex: string): Rgba;
export declare function toHex(rgb: { r: number; g: number; b: number }): string;
/** Composite `color` over `on` at `alpha`; returns `#RRGGBB`. */
export declare function tint(color: string, on: string, alpha: number): string;

export interface Leaf {
  path: string[];
  token: { $type?: string; $value: unknown; $description?: string; $extensions?: Record<string, unknown> };
}
export declare function collectLeaves(tree: Record<string, unknown>, inheritedType?: string, prefix?: string[]): Leaf[];
export declare function expandModes(tree: Record<string, unknown>): PreprocessedTokens;
export declare function loadTokens(): DesignTokens & Record<string, unknown>;

export interface BuildOptions {
  outDir?: string;
  /** Where to copy the native theme for committing; `null` skips the copy. */
  generatedFile?: string | null;
  silent?: boolean;
}
export interface BuildResult {
  outDir: string;
  files: { css: string; tailwind: string; native: string; json: string };
  generatedFile: string | null;
}
export declare function makeConfig(options?: Pick<BuildOptions, 'outDir' | 'silent'>): Config;
export declare function buildTokens(options?: BuildOptions): Promise<BuildResult>;

declare const config: Config;
export default config;

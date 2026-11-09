// The domain-association files, written at build time into out/.well-known/ (T-0048). One handler, with the file names decided by the
// configuration: the Stripe file exists only when STRIPE_APPLE_PAY_DOMAIN_FILE is set. A static host cannot send these headers, so
// the deploy job sets the content types (apple-app-site-association must be application/json): .github/workflows/deploy-web.yml.
import { APP_IDS } from '../../../src/app-ids.ts';
import { loadBuildConfig } from '../../../src/site-config.ts';
import { renderAppleAppSiteAssociation, renderAssetLinks } from '../../../src/well-known.ts';

export const dynamic = 'force-static';
export const dynamicParams = false;

const AASA = 'apple-app-site-association';
const ASSETLINKS = 'assetlinks.json';
const STRIPE = 'apple-developer-merchantid-domain-association';

export function generateStaticParams() {
  const cfg = loadBuildConfig(process.env);
  return [AASA, ASSETLINKS, ...(cfg.stripeApplePayFile === undefined ? [] : [STRIPE])].map((file) => ({ file }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const json = (v: unknown) => new Response(`${JSON.stringify(v, null, 2)}\n`, { headers: { 'content-type': 'application/json' } });
  if (file === AASA) return json(renderAppleAppSiteAssociation(APP_IDS));
  if (file === ASSETLINKS) return json(renderAssetLinks(APP_IDS));
  const stripe = loadBuildConfig(process.env).stripeApplePayFile;
  if (file === STRIPE && stripe !== undefined) return new Response(stripe, { headers: { 'content-type': 'text/plain' } });
  return new Response('not found', { status: 404 });
}

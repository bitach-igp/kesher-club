// The domain-association files, rendered from the one ids module (T-0048). Pure: the build's route handler and the tests call these.
import type { AppIds } from './app-ids.ts';

/**
 * `/.well-known/apple-app-site-association`: `webcredentials` lets the app use passkeys for this domain (the WebAuthn relying party),
 * `applinks` lets it open links on the domain. The marketing pages (`/`, `/support`, `/legal/*`) are excluded so the app's own legal
 * links open in the browser; every other path is reserved for the app's deep links (T-0058).
 */
export function renderAppleAppSiteAssociation(ids: AppIds): unknown {
  const appId = `${ids.appleTeamId}.${ids.iosBundleId}`;
  return {
    applinks: {
      details: [
        {
          appIDs: [appId],
          components: [
            { '/': '/', exclude: true },
            { '/': '/support', exclude: true },
            { '/': '/legal', exclude: true },
            { '/': '/legal/*', exclude: true },
            { '/': '/*' },
          ],
        },
      ],
    },
    webcredentials: { apps: [appId] },
  };
}

/** `/.well-known/assetlinks.json`: the Android app may handle the domain's links and use its credentials (passkeys). */
export function renderAssetLinks(ids: AppIds): unknown {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
      target: { namespace: 'android_app', package_name: ids.androidPackage, sha256_cert_fingerprints: [...ids.androidCertSha256] },
    },
  ];
}

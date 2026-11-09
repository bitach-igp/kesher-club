import { Bilingual } from '../bilingual.tsx';
import { COPY } from '../../src/copy.ts';
import { DOC_KEYS, legalDocuments } from '../../src/legal.ts';
import { loadBuildConfig } from '../../src/site-config.ts';

export const metadata = { title: 'Legal · Kesher Club' };

export default async function LegalIndex() {
  const docs = await legalDocuments(loadBuildConfig(process.env).legalApiUrl);
  return (
    <Bilingual
      as="section"
      render={(lang) => (
        <>
          <h1>{COPY[lang].legal}</h1>
          <p>{COPY[lang].legalIntro}</p>
          <ul>
            {DOC_KEYS.map((k) => (
              <li key={k}>
                {/* The same URL the app links: /legal/<docKey>?lang=<locale> (apps/mobile/src/consent.ts). */}
                <a href={`/legal/${k}?lang=${lang}`}>{docs[k].title[lang]}</a>
              </li>
            ))}
          </ul>
        </>
      )}
    />
  );
}

// One page per document, both languages in the HTML. The app links /legal/<docKey>?lang=<locale>; a static host ignores the query, so
// public/lang.js reads it and shows that language. The text is a plain string in a text node: React escapes it, nothing is parsed as
// markup, and `white-space: pre-wrap` keeps the line breaks.
import { notFound } from 'next/navigation';
import { Bilingual } from '../../bilingual.tsx';
import { COPY } from '../../../src/copy.ts';
import { DOC_KEYS, isDocKey, legalDocuments } from '../../../src/legal.ts';
import { loadBuildConfig } from '../../../src/site-config.ts';

export const dynamicParams = false;

export function generateStaticParams() {
  return DOC_KEYS.map((docKey) => ({ docKey }));
}

export async function generateMetadata({ params }: { params: Promise<{ docKey: string }> }) {
  const { docKey } = await params;
  if (!isDocKey(docKey)) return {};
  const doc = (await legalDocuments(loadBuildConfig(process.env).legalApiUrl))[docKey];
  return { title: `${doc.title.en} · ${doc.title.he}` };
}

export default async function LegalDocument({ params }: { params: Promise<{ docKey: string }> }) {
  const { docKey } = await params;
  if (!isDocKey(docKey)) notFound();
  const doc = (await legalDocuments(loadBuildConfig(process.env).legalApiUrl))[docKey];
  return (
    <Bilingual
      as="section"
      render={(lang) => (
        <article>
          <h1>{doc.title[lang]}</h1>
          <p className="muted">
            {COPY[lang].version} {doc.version} · {COPY[lang].inForce} {doc.effectiveDate}
          </p>
          <div className="legal-body">{doc.body[lang]}</div>
          <p className="muted">
            {COPY[lang].fingerprint}: <code>{doc.hash}</code>
          </p>
        </article>
      )}
    />
  );
}

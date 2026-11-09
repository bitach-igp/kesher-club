// Both languages are in the HTML; `public/lang.js` hides one when the URL asks for it (?lang=). Each block carries its own lang and dir.
import type { ReactNode } from 'react';
import { DIR, type Lang } from '../src/copy.ts';
import { LANGS } from '../src/legal.ts';

export function Bilingual({ render, as: Tag = 'div' }: { render: (lang: Lang) => ReactNode; as?: 'div' | 'section' | 'p' | 'span' }) {
  return (
    <>
      {LANGS.map((lang) => (
        <Tag key={lang} lang={lang} dir={DIR[lang]} data-l={lang} className="block">
          {render(lang)}
        </Tag>
      ))}
    </>
  );
}

import { Bilingual } from '../bilingual.tsx';
import { COPY } from '../../src/copy.ts';
import { SUPPORT_EMAIL } from '../../src/site-config.ts';

export const metadata = { title: 'Support · Kesher Club' };

export default function Support() {
  return (
    <Bilingual
      as="section"
      render={(lang) => (
        <>
          <h1>{COPY[lang].supportTitle}</h1>
          <p>{COPY[lang].supportBody}</p>
          <p>
            <a className="button" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
          </p>
        </>
      )}
    />
  );
}

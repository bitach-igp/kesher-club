import { Bilingual } from './bilingual.tsx';
import { COPY } from '../src/copy.ts';

export default function Landing() {
  return (
    <Bilingual
      as="section"
      render={(lang) => (
        <>
          <h1>{COPY[lang].brand}</h1>
          <p className="lead">{COPY[lang].tagline}</p>
          <p>
            <a className="button" href="/support">
              {COPY[lang].support}
            </a>
          </p>
        </>
      )}
    />
  );
}

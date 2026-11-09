import { describe, expect, it } from 'vitest';
import { auditCss, auditHtml } from './static-audit.ts';

describe('static output audit (T-0048)', () => {
  it('accepts same-origin scripts, styles and links, and plain links to other sites', () => {
    const html = '<link rel="stylesheet" href="/_next/static/a.css"/><script src="/lang.js"></script><script>inline()</script><a href="https://example.test/x">x</a><a href="mailto:a@b.test">m</a>';
    expect(auditHtml(html, 'p.html')).toEqual([]);
  });

  it('catches third-party scripts, styles, fonts, preloads, frames and images', () => {
    const html =
      '<script src="https://cdn.test/a.js"></script><script async src=//cdn.test/b.js></script>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css"><link rel="preload" as="font" href="http://x.test/f.woff2">' +
      '<iframe src="https://www.youtube.com/embed/x"></iframe><img src="https://pixel.test/p.gif"><form action="https://x.test/post"></form>';
    expect(auditHtml(html, 'p.html')).toHaveLength(7);
  });

  it('catches inline event handlers, but not the word in text', () => {
    expect(auditHtml('<a href="/" onclick="x()">a</a><body onload=y()>', 'p.html')).toHaveLength(2);
    expect(auditHtml('<p>press onclick=nothing</p><div data-once="1"></div>', 'p.html')).toEqual([]);
  });

  it('catches off-origin CSS url() and @import, including in a <style> block', () => {
    expect(auditCss('a{background:url(https://t.test/p.png)}@import "https://t.test/a.css";@import url(//t.test/b.css);', 'a.css')).toHaveLength(3);
    expect(auditCss('a{background:url(/img/p.png)}@font-face{src:url("/f.woff2")}', 'a.css')).toEqual([]);
    expect(auditHtml('<style>@import url(https://t.test/a.css)</style>', 'p.html')).toHaveLength(1);
  });
});

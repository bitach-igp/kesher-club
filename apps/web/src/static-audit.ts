// Audits the static output (T-0048): the site loads nothing from a third party. Pure text checks over the HTML and CSS the build wrote;
// the tests run them on a fixture build. Allowed: same-origin references (`/x`, `x`, `?lang=`, `#id`), `mailto:`, and plain `<a>` links
// to other sites (a link is not a load). Refused: a script, stylesheet, font, image, frame, preload or CSS `url()` that points off
// origin, and any inline event-handler attribute (`onclick=` and kin).
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i; // http://, https://, //host
const SCHEME_NOT_LOCAL = /^(?:https?|ftp|ws|wss):/i;

const isExternal = (url: string) => EXTERNAL.test(url.trim()) || SCHEME_NOT_LOCAL.test(url.trim());

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** Returns one message per offence; empty means clean. */
export function auditHtml(html: string, file: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const name = (m[1] ?? '').toLowerCase();
    const tag = `<${name}${m[2] ?? ''}>`;
    for (const h of tag.matchAll(/\s(on[a-z]+)\s*=/gi)) out.push(`${file}: inline event handler ${h[1]} on <${name}>`);
    if (name === 'script') {
      const src = attr(tag, 'src');
      if (src !== undefined && isExternal(src)) out.push(`${file}: external script ${src}`);
    } else if (name === 'link') {
      const href = attr(tag, 'href');
      if (href !== undefined && isExternal(href)) out.push(`${file}: external <link> ${href}`);
    } else if (['img', 'iframe', 'embed', 'object', 'source', 'video', 'audio', 'track', 'frame'].includes(name)) {
      const src = attr(tag, 'src') ?? attr(tag, 'data');
      if (src !== undefined && isExternal(src)) out.push(`${file}: external <${name}> ${src}`);
    } else if (name === 'form') {
      const action = attr(tag, 'action');
      if (action !== undefined && isExternal(action)) out.push(`${file}: form posts off origin ${action}`);
    }
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out.push(...auditCss(m[1] ?? '', `${file} <style>`));
  return out;
}

export function auditCss(css: string, file: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/url\(\s*['"]?([^'")\s]+)/gi)) {
    const u = m[1] ?? '';
    if (isExternal(u)) out.push(`${file}: external url() ${u}`);
  }
  // `@import url(...)` is caught by the url() pass above; this is the quoted form.
  for (const m of css.matchAll(/@import\s+['"]([^'"]+)/gi)) {
    const u = m[1] ?? '';
    if (isExternal(u)) out.push(`${file}: external @import ${u}`);
  }
  return out;
}

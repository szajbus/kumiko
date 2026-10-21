/**
 * What an HTML artifact may do, put first in it, as content can only tighten a policy, not loosen it. It may load from
 * https anywhere (CDNs: Tailwind, fonts, chart libraries) and fetch over https, but nothing over plain http, which is
 * how it would reach this machine and its network, and it can't submit forms or change its base URL.
 */
export const HTML_POLICY =
  "default-src https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src https:; img-src https: data: blob:; frame-src https:; form-action 'none'; base-uri 'none'";

/** `html` with the policy as its first element: after a doctype, which has to come first or the page renders in quirks mode. */
export function withPolicy(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_POLICY}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + meta + html.slice(doctype[0].length) : meta + html;
}

import type { APIRoute } from 'astro';
import { getDocs } from '../../../lib/docs';

const escapeXml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

export const getStaticPaths = async () => (await getDocs()).map((doc) => ({
  params: { repo: doc.repo, slug: doc.slug },
  props: { title: doc.title, repo: doc.repo, status: doc.status },
}));

export const GET: APIRoute = ({ props }) => {
  const title = escapeXml(String(props.title));
  const repo = escapeXml(String(props.repo));
  const status = escapeXml(String(props.status));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#191817"/><rect x="72" y="72" width="1056" height="486" rx="28" fill="#242220" stroke="#403c36"/><text x="120" y="160" fill="#c7a6f2" font-family="sans-serif" font-size="28">DESIGN DOCS / ${repo}</text><text x="120" y="280" fill="#ede8df" font-family="sans-serif" font-size="52" font-weight="700">${title}</text><text x="120" y="480" fill="#aaa297" font-family="sans-serif" font-size="28">status: ${status}</text></svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' } });
};

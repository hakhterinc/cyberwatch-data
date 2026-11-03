// Run with: node --test aggregate.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregate, canonicalUrl, classifySeverity, mergeArticles, parseFeed } from './aggregate.mjs';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const DATE = 'Mon, 02 Nov 2026 12:00:00 GMT';
const rss = (items) => `<rss><channel>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.date}</pubDate><description><![CDATA[<p>Text</p><script>alert(1)</script>]]></description></item>`).join('')}</channel></rss>`;
const FEEDS = [
  { id: 'a', publisher: 'A', url: 'https://a.test/feed' },
  { id: 'b', publisher: 'B', url: 'https://b.test/feed' },
  { id: 'none', publisher: 'None', url: null, unavailableReason: 'No feed' },
];
const article = (id, ageDays) => ({ headline: `Headline ${id}`, url: `https://x.test/${id}`, publishedAt: new Date(NOW - ageDays * 864e5).toISOString() });

test('parses RSS and Atom into plain text', () => {
  const [item] = parseFeed(rss([{ title: 'T &amp; U', link: 'https://x.test/1', date: DATE }]));
  assert.equal(item.headline, 'T & U');
  assert.equal(item.summary, 'Text');
  const [entry] = parseFeed('<feed><entry><title>E</title><link rel="alternate" href="https://x.test/e"/><published>2026-11-01T00:00:00Z</published></entry></feed>');
  assert.equal(entry.link, 'https://x.test/e');
});

test('rejects an HTML page served at a feed URL', () => {
  assert.throws(() => parseFeed('<html><body>not a feed</body></html>'));
});

test('reads the two-digit years CISA uses', () => {
  assert.equal(new Date(Date.parse('Mon, 02 Nov 26 12:00:00 +0000')).getUTCFullYear(), 2026);
});

test('canonicalUrl removes tracking and refuses unsafe schemes', () => {
  assert.equal(canonicalUrl('https://x.test/1/?utm_source=z&id=2#frag'), 'https://x.test/1?id=2');
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
});

test('classifySeverity handles plurals, floors and neutral stories', () => {
  assert.equal(classifySeverity('Vendor warns of critical flaws'), 'critical');
  assert.equal(classifySeverity('Company picks new CEO'), 'info');
  assert.equal(classifySeverity('Company picks new CEO', 'medium'), 'medium');
});

test('skips a failed feed and drops articles without a real date or safe link', async () => {
  const body = rss([
    { title: 'Good', link: 'https://a.test/1', date: DATE },
    { title: 'Bad date', link: 'https://a.test/2', date: 'unknown' },
    { title: 'Bad link', link: 'javascript:alert(1)', date: DATE },
  ]);
  const result = await aggregate(null, {
    feeds: FEEDS,
    now: NOW,
    fetchImpl: async (url) => (url.includes('a.test') ? new Response(body) : new Response('<html>', { status: 500 })),
  });
  assert.deepEqual(result.articles.map((a) => a.headline), ['Good']);
  assert.deepEqual(Object.keys(result.articles[0]).sort(), ['category', 'headline', 'publishedAt', 'publisher', 'severity', 'summary', 'url']);
  assert.equal(result.sources.find((s) => s.id === 'b').status, 'error');
  assert.equal(result.sources.find((s) => s.id === 'none').status, 'unavailable');
});

test('a total outage keeps old articles and does not advance lastSuccessAt', async () => {
  const previous = { lastSuccessAt: new Date(NOW - 6e5).toISOString(), articles: [article(1, 1)], sources: [] };
  const result = await aggregate(previous, { feeds: FEEDS, now: NOW, fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(result.articles.length, 1);
  assert.equal(result.lastSuccessAt, previous.lastSuccessAt);
  assert.equal(result.lastAttemptAt, new Date(NOW).toISOString());
});

test('sends stored validators and treats 304 as a successful check', async () => {
  const previous = { lastSuccessAt: null, articles: [article(1, 1)], sources: [{ id: 'a', etag: '"v1"' }] };
  let sent;
  const result = await aggregate(previous, {
    feeds: [FEEDS[0]],
    now: NOW,
    fetchImpl: async (_url, options) => { sent = options.headers; return new Response(null, { status: 304 }); },
  });
  assert.equal(sent['If-None-Match'], '"v1"');
  assert.equal(result.articles.length, 1);
  assert.equal(result.lastSuccessAt, new Date(NOW).toISOString());
});

test('keeps seven days at most, then the newest 100, without duplicates', () => {
  assert.equal(mergeArticles([], [article(1, 8), article(2, 6)], NOW).length, 1);
  assert.equal(mergeArticles(Array.from({ length: 150 }, (_, i) => article(i, 1)), [], NOW).length, 100);
  assert.equal(mergeArticles([article(1, 1)], [article(1, 1), { ...article(9, 1), headline: 'Headline 1' }], NOW).length, 1);
});

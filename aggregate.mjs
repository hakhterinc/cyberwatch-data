#!/usr/bin/env node
// CyberWatch RSS aggregator. No dependencies, no AI calls, no database.
//
//   node aggregate.mjs <path/to/news.json>
//
// Reads the previous news.json (if any), merges in whatever the feeds return,
// and rewrites the file. A feed that fails is skipped; earlier articles are kept.
// `lastSuccessAt` only moves when at least one feed really was reached, so the
// dashboard can always tell viewers how old the data is.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAX_ARTICLES = 100;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SUMMARY_LENGTH = 280;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FEED_BYTES = 3 * 1024 * 1024;
const USER_AGENT = 'hAkhterLabs-CyberWatch/1.0 (+https://hakhter.com/cyberwatch)';

// Each feed is requested once per run, with ETag / Last-Modified when the
// publisher supplies them. CISA's combined all.xml (6 MB) is deliberately not used.
export const FEEDS = [
  { id: 'cisa-alerts', publisher: 'CISA', url: 'https://www.cisa.gov/cybersecurity-advisories/alerts.xml', severityFloor: 'medium' },
  { id: 'cisa-news', publisher: 'CISA', url: 'https://www.cisa.gov/news.xml' },
  { id: 'bleepingcomputer', publisher: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/' },
  { id: 'thehackernews', publisher: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews' },
  { id: 'krebs', publisher: 'Krebs on Security', url: 'https://krebsonsecurity.com/feed/' },
  // tsec.ai publishes no RSS or Atom feed (checked 2026-11-03). Its pages are not
  // scraped. Set `url` here if a feed appears.
  { id: 'tsec', publisher: 'tsec.ai', url: null, unavailableReason: 'No RSS feed published' },
];

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] !== '#') return NAMED_ENTITIES[code.toLowerCase()] ?? match;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

// Feed text may be CDATA, entity-escaped HTML, or both, so tags are stripped
// again after decoding. The output is plain text and is rendered as plain text.
function toPlainText(raw) {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const stripTags = (s) => s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ');
  return stripTags(decodeEntities(stripTags(unwrapped))).replace(/\s+/g, ' ').trim();
}

function firstTag(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'i'));
    if (match) return match[1];
  }
  return '';
}

function atomLink(block) {
  const links = block.match(/<link\b[^>]*>/gi) || [];
  const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i')) || [])[1];
  const chosen = links.find((tag) => (attr(tag, 'rel') || 'alternate') === 'alternate') || links[0];
  return chosen ? attr(chosen, 'href') || '' : '';
}

export function parseFeed(xml) {
  if (!/<(rss|feed|rdf:RDF)\b/i.test(xml)) throw new Error('Response is not an RSS or Atom feed');
  const blocks = xml.match(/<item\b[\s\S]*?<\/item\s*>|<entry\b[\s\S]*?<\/entry\s*>/gi) || [];
  return blocks.map((block) => ({
    headline: toPlainText(firstTag(block, ['title'])),
    summary: toPlainText(firstTag(block, ['description', 'summary', 'content:encoded', 'content'])),
    link: toPlainText(firstTag(block, ['link'])) || atomLink(block),
    date: toPlainText(firstTag(block, ['pubDate', 'published', 'updated', 'dc:date'])),
    feedCategories: (block.match(/<category\b[^>]*>[\s\S]*?<\/category\s*>/gi) || []).map(toPlainText),
  }));
}

export function canonicalUrl(raw, base) {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return null;
  }
}

function shorten(text, length) {
  if (text.length <= length) return text;
  const cut = text.slice(0, length);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > length * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:–—-]+$/, '')}…`;
}

// Severity and category are keyword estimates, not publisher ratings. The
// dashboard labels them that way.
const SEVERITY_RULES = [
  ['critical', /\b(actively exploited|exploited in the wild|zero[- ]day|0[- ]day|cvss\s*(score\s*)?(of\s*)?(9(\.\d)?|10(\.0)?)|critical (flaws?|bugs?|vulnerabilit\w+|rce)|mass exploitation|emergency directive|known exploited)\b/i],
  ['high', /\b(ransomware|remote code execution|rce|data breach|breach(ed)?|supply[- ]chain|backdoor|actively|exploit(s|ed|ation)?|wiper|hijack\w*|stolen|leak(s|ed)?|botnet|state[- ]sponsored)\b/i],
  ['medium', /\b(vulnerabilit\w+|flaws?|bugs?|malware|phishing|patch(es|ed)?|trojan|infostealer|scam|ddos|advisory|warn(s|ing)?|attack(s|ers?)?|hackers?)\b/i],
];
const SEVERITY_ORDER = ['info', 'medium', 'high', 'critical'];

export function classifySeverity(text, floor = 'info') {
  const found = (SEVERITY_RULES.find(([, pattern]) => pattern.test(text)) || ['info'])[0];
  return SEVERITY_ORDER.indexOf(found) >= SEVERITY_ORDER.indexOf(floor) ? found : floor;
}

const CATEGORY_RULES = [
  ['Ransomware', /\b(ransomware|extortion)\b/i],
  ['Vulnerability', /\b(zero[- ]day|0[- ]day|cve-\d+|vulnerabilit\w+|flaws?|patch(es|ed)?|remote code execution|rce|exploit\w*)\b/i],
  ['Data Breach', /\b(breach\w*|data leak|leak(s|ed)?|stolen data|exposed)\b/i],
  ['Phishing', /\b(phishing|smishing|scam\w*|social engineering)\b/i],
  ['Malware', /\b(malware|trojan|infostealer|stealer|botnet|backdoor|spyware|wiper|worm|rootkit)\b/i],
  ['Nation-State', /\b(apt\d*|nation[- ]state|state[- ]sponsored|espionage|north korea\w*|russia\w*|chin(a|ese)|iran\w*)\b/i],
  ['Policy & Guidance', /\b(cisa|fbi|nsa|guidance|advisory|regulation|law|sanction\w*|strategy|arrest\w*|charged|sentenced)\b/i],
  ['AI Security', /\b(ai|llm\w*|artificial intelligence|prompt injection)\b/i],
];

export function classifyCategory(headline, summary, feedCategories = []) {
  for (const text of [headline, `${summary} ${feedCategories.join(' ')}`]) {
    const match = CATEGORY_RULES.find(([, pattern]) => pattern.test(text));
    if (match) return match[0];
  }
  return 'General';
}

export function normalizeEntry(entry, feed, nowMs) {
  const url = canonicalUrl(entry.link, feed.url);
  const publishedMs = Date.parse(entry.date);
  // An article without a real date or link is dropped: a timestamp is never invented.
  if (!url || !entry.headline || !Number.isFinite(publishedMs)) return null;
  if (publishedMs > nowMs + 60 * 60 * 1000) return null;
  return {
    headline: shorten(entry.headline, 240),
    summary: shorten(entry.summary, SUMMARY_LENGTH),
    publisher: feed.publisher,
    publishedAt: new Date(publishedMs).toISOString(),
    category: classifyCategory(entry.headline, entry.summary, entry.feedCategories),
    severity: classifySeverity(`${entry.headline} ${entry.summary}`, feed.severityFloor),
    url,
  };
}

const headlineKey = (headline) => headline.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Fresh copies win over stored copies. Keeps articles at most seven days old,
// then the newest 100, whichever is smaller.
export function mergeArticles(incoming, previous, nowMs) {
  const seenUrls = new Set();
  const seenHeadlines = new Set();
  const merged = [];
  for (const article of [...incoming, ...previous]) {
    const key = headlineKey(article.headline);
    if (seenUrls.has(article.url) || seenHeadlines.has(key)) continue;
    seenUrls.add(article.url);
    seenHeadlines.add(key);
    merged.push(article);
  }
  return merged
    .filter((article) => nowMs - Date.parse(article.publishedAt) <= MAX_AGE_MS)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, MAX_ARTICLES);
}

async function readCapped(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_FEED_BYTES) {
      await reader.cancel();
      throw new Error('Feed is larger than the size limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchFeed(feed, previous, fetchImpl) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8' };
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
  const response = await fetchImpl(feed.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const validators = {
    etag: response.headers.get('etag') || previous?.etag || null,
    lastModified: response.headers.get('last-modified') || previous?.lastModified || null,
  };
  if (response.status === 304) return { entries: [], validators };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { entries: parseFeed(await readCapped(response)), validators };
}

export async function aggregate(previous, { feeds = FEEDS, fetchImpl = fetch, now = Date.now() } = {}) {
  const nowIso = new Date(now).toISOString();
  const previousSources = new Map((previous?.sources || []).map((source) => [source.id, source]));
  const incoming = [];
  const results = await Promise.all(feeds.map(async (feed) => {
    const before = previousSources.get(feed.id);
    const base = { id: feed.id, publisher: feed.publisher };
    if (!feed.url) return { ...base, status: 'unavailable', error: feed.unavailableReason, lastSuccessAt: null, articleCount: 0 };
    try {
      const { entries, validators } = await fetchFeed(feed, before, fetchImpl);
      const articles = entries.map((entry) => normalizeEntry(entry, feed, now)).filter(Boolean);
      incoming.push(...articles);
      return { ...base, status: 'ok', error: null, lastSuccessAt: nowIso, articleCount: articles.length, ...validators };
    } catch (error) {
      const message = error.name === 'TimeoutError' ? 'Timed out' : String(error.message || error).slice(0, 160);
      console.warn(`[cyberwatch] skipped ${feed.id}: ${message}`);
      return { ...base, status: 'error', error: message, lastSuccessAt: before?.lastSuccessAt || null, articleCount: 0, etag: before?.etag || null, lastModified: before?.lastModified || null };
    }
  }));

  const reached = results.some((source) => source.status === 'ok');
  return {
    schemaVersion: 1,
    lastAttemptAt: nowIso,
    lastSuccessAt: reached ? nowIso : previous?.lastSuccessAt || null,
    sources: results,
    articles: mergeArticles(incoming, previous?.articles || [], now),
  };
}

function readPrevious(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed.articles) ? parsed : null;
  } catch (error) {
    console.warn(`[cyberwatch] ignoring unreadable ${path}: ${error.message}`);
    return null;
  }
}

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) {
    console.error('Usage: node aggregate.mjs <path/to/news.json>');
    process.exit(2);
  }
  const result = await aggregate(readPrevious(outputPath));
  const temporaryPath = `${outputPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temporaryPath, outputPath);
  for (const source of result.sources) {
    console.log(`[cyberwatch] ${source.id}: ${source.status} (${source.articleCount} articles)${source.error ? ` - ${source.error}` : ''}`);
  }
  console.log(`[cyberwatch] kept ${result.articles.length} articles; lastSuccessAt=${result.lastSuccessAt}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

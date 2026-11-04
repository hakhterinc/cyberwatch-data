# CyberWatch news feed

Builds the static `news.json` behind <https://hakhter.com/cyberwatch>. It has no dependencies, no AI calls and no database.

This folder is a template for a **separate public repository**, `hakhterinc/cyberwatch-data`. GitHub Actions does not run workflows from this subfolder. Standard runners are free only on public repositories, and a run every 10 minutes (about 4,300 minutes a month) would exceed the private-repo allowance of about 2,000. The HakhterLabs repo must stay private, so the feed lives on its own. It holds only code and public headlines, and needs no secrets.

## Data flow

```
RSS feeds → aggregate.mjs (GitHub Actions, every 10 min) → "data" branch: news.json
         → raw.githubusercontent.com → hakhter.com/cyberwatch/news.json (Worker, edge cached) → browser
```

## Setup

1. Create an empty **public** GitHub repository named `cyberwatch-data` under `hakhterinc`.
2. Copy the contents of this folder, including `.github/`, to the root of that repository and push to its default branch.
3. On the repository's **Actions** tab, open **Refresh CyberWatch news** and choose **Run workflow**. Confirm that a `data` branch containing `news.json` appears.
4. Check the run log. Each source reports `ok`, `error` or `unavailable`.

If you use a different repository name, update `CYBERWATCH_NEWS_SOURCE` in `src/worker.js`.

## Upkeep

- GitHub may delay scheduled runs. The dashboard then shows "News delayed" after 30 minutes and "News out of date" after 2 hours.
- GitHub can disable scheduled workflows in a public repository after 60 days without activity. If the dashboard stays out of date, check the Actions tab and re-enable the workflow.
- To add a source, add an entry to `FEEDS` in `aggregate.mjs`. Use a real RSS or Atom feed only.

## `news.json`

```json
{
  "schemaVersion": 1,
  "lastAttemptAt": "2026-11-03T19:13:00.000Z",
  "lastSuccessAt": "2026-11-03T19:13:00.000Z",
  "sources": [
    { "id": "krebs", "publisher": "Krebs on Security", "status": "ok", "error": null, "lastSuccessAt": "2026-11-03T19:13:00.000Z", "articleCount": 10, "etag": null, "lastModified": null }
  ],
  "articles": [
    {
      "headline": "…",
      "summary": "Plain text, 280 characters at most",
      "publisher": "BleepingComputer",
      "publishedAt": "2026-11-03T18:51:04.000Z",
      "category": "Vulnerability",
      "severity": "critical",
      "url": "https://…"
    }
  ]
}
```

`lastSuccessAt` advances only when at least one feed was reached. The file keeps the newest 100 articles by publication time, with duplicates removed by normalized URL. `severity` is one of `critical`, `high`, `medium` or `info`. Severity and category are keyword estimates, not publisher ratings.

## Run locally

```bash
node --test aggregate.test.mjs
```

```bash
node aggregate.mjs /tmp/news.json
```

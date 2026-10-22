#!/usr/bin/env node
// AI token usage card renderer. Node 20+, no dependencies.
//
// - Cursor: if CURSOR_ADMIN_API_KEY and CURSOR_USER_EMAIL are both set, sums
//   tokens (input + output + cache write + cache read) over the LAST 30 DAYS
//   from the Cursor Admin API (Enterprise only). Otherwise, or on any error: n/a.
// - Grok Bot / Grok Build: always n/a (no official usage API).
// - Never outputs cost, email, or org/team names. Never logs response bodies.
//
// Usage: node scripts/token-stats.mjs [--out token-stats.svg]

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const API_URL = "https://api.cursor.com/teams/filtered-usage-events";
const WINDOW_DAYS = 30;
const PAGE_SIZE = 1000;
const MAX_PAGES = 500; // hard safety cap
const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const args = { out: "token-stats.svg" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

const log = (msg) => console.log(`[token-stats] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Cursor ----------

class GenericError extends Error {} // message is safe to log

async function postWithBackoff(body, auth) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt < MAX_RETRIES) { await sleep(backoffMs(attempt)); continue; }
      throw new GenericError("network error");
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => {});
      if (attempt < MAX_RETRIES) {
        const ra = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 120_000) : backoffMs(attempt);
        await sleep(wait);
        continue;
      }
      throw new GenericError(res.status === 429 ? "rate limited" : `upstream HTTP ${res.status}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new GenericError(`HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new GenericError("unparseable response");
    }
  }
}

function backoffMs(attempt) {
  return Math.min(2 ** attempt * 2000, 60_000) + Math.floor(Math.random() * 500);
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

async function fetchCursorTokens(apiKey, email) {
  const auth = Buffer.from(`${apiKey}:`).toString("base64");
  const endDate = Date.now();
  const startDate = endDate - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const wanted = email.trim().toLowerCase();
  let total = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await postWithBackoff({ startDate, endDate, email: email.trim(), page, pageSize: PAGE_SIZE }, auth);
    const events = Array.isArray(data?.usageEvents) ? data.usageEvents : null;
    if (!events) throw new GenericError("unexpected response shape");
    for (const ev of events) {
      // Second-layer filter: only the configured user's events.
      if (typeof ev?.userEmail === "string" && ev.userEmail.trim().toLowerCase() !== wanted) continue;
      const t = ev?.tokenUsage;
      if (!t) continue;
      total += num(t.inputTokens) + num(t.outputTokens) + num(t.cacheWriteTokens) + num(t.cacheReadTokens);
    }
    const p = data?.pagination;
    const hasNext = p?.hasNextPage === true || (typeof p?.numPages === "number" && page < p.numPages);
    if (!hasNext || events.length === 0) return total;
  }
  throw new GenericError("too many pages");
}

async function cursorRow() {
  const key = process.env.CURSOR_ADMIN_API_KEY?.trim();
  const email = process.env.CURSOR_USER_EMAIL?.trim();
  if (!key || !email) {
    log("Cursor: secrets not configured -> n/a");
    return null;
  }
  try {
    const total = await fetchCursorTokens(key, email);
    log("Cursor: OK");
    return total;
  } catch (err) {
    const reason = err instanceof GenericError ? err.message : "unexpected error";
    log(`Cursor: ${reason} -> n/a`);
    return null;
  }
}

// ---------- formatting ----------

export function formatTokens(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  const units = [["T", 1e12], ["B", 1e9], ["M", 1e6], ["K", 1e3]];
  for (const [u, v] of units) {
    if (n >= v) {
      const x = n / v;
      const s = x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, "");
      return `${s}${u}`;
    }
  }
  return String(Math.round(n));
}

function bangkokDate(d = new Date()) {
  // UTC+7, no DST.
  return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- SVG ----------

function renderSvg(rows, updated) {
  const W = 420, rowH = 40, top = 74;
  const H = top + rows.length * rowH + 40;
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, 'DejaVu Sans', sans-serif";

  const rowSvg = rows.map((r, i) => {
    const y = top + i * rowH;
    const na = r.value === "n/a";
    return `
  <g transform="translate(0 ${y})">
    ${i > 0 ? `<line class="sep" x1="24" y1="0" x2="${W - 24}" y2="0"/>` : ""}
    <circle class="dot ${na ? "dot-na" : "dot-ok"}" cx="30" cy="${rowH / 2}" r="4"/>
    <text class="label" x="44" y="${rowH / 2 + 5}">${esc(r.label)}</text>
    <text class="value ${na ? "na" : ""}" x="${W - 24}" y="${rowH / 2 + 5}" text-anchor="end">${esc(r.value)}</text>
  </g>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
  <title id="t">AI Token Usage</title>
  <desc id="d">${esc(rows.map((r) => `${r.label}: ${r.value}`).join("; "))}. Tokens, last ${WINDOW_DAYS} days. Updated ${updated} (UTC+7).</desc>
  <style>
    .bg { fill: #ffffff; stroke: #d0d7de; }
    .title { fill: #1f2328; font: 600 18px ${font}; }
    .sub { fill: #656d76; font: 400 12px ${font}; }
    .label { fill: #1f2328; font: 500 14px ${font}; }
    .value { fill: #0969da; font: 600 15px ${font}; font-variant-numeric: tabular-nums; }
    .value.na { fill: #8c959f; font-weight: 500; }
    .sep { stroke: #eaeef2; stroke-width: 1; }
    .dot-ok { fill: #1a7f37; }
    .dot-na { fill: #afb8c1; }
    .foot { fill: #656d76; font: 400 11px ${font}; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; stroke: #30363d; }
      .title { fill: #e6edf3; }
      .sub, .foot { fill: #8d96a0; }
      .label { fill: #e6edf3; }
      .value { fill: #58a6ff; }
      .value.na { fill: #6e7681; }
      .sep { stroke: #21262d; }
      .dot-ok { fill: #3fb950; }
      .dot-na { fill: #484f58; }
    }
  </style>
  <rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10"/>
  <text class="title" x="24" y="36">AI Token Usage</text>
  <text class="sub" x="24" y="56">tokens · last ${WINDOW_DAYS} days</text>${rowSvg}
  <text class="foot" x="24" y="${H - 16}">updated ${esc(updated)} (UTC+7) · n/a = no official API</text>
</svg>
`;
}

// ---------- main ----------

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const cursor = await cursorRow();
  const rows = [
    { label: "Grok Bot", value: "n/a" },
    { label: "Grok Build", value: "n/a" },
    { label: "Cursor", value: formatTokens(cursor) },
  ];
  const svg = renderSvg(rows, bangkokDate());
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, svg);
  log(`wrote ${out}`);
}

main().catch(() => {
  log("fatal: unexpected error");
  process.exit(1);
});

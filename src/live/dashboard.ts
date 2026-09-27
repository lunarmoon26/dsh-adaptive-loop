import { createServer, type Server } from "node:http";

import { DalError } from "../errors.js";
import { liveReview } from "./loop.js";

export interface LiveReviewDashboard {
  url: string;
  close(): Promise<void>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function renderPage(campaign: string, view: Awaited<ReturnType<typeof liveReview>>): string {
  const review = view.review;
  const content = review === null
    ? `<p>No candidate is awaiting or carrying a review decision for this campaign.</p>`
    : `<p><a class="button" href="/review-request.json" download>Download review request</a></p>
<p>Approve or reject the downloaded request out of band with a human-attested DAL decision. This page cannot create a decision or change the active generation.</p>
<h2>Candidate</h2><pre>${escapeHtml(review.candidate.prompt)}</pre>
<h2>Incumbent</h2><pre>${escapeHtml(review.incumbent.prompt)}</pre>
<h2>Deterministic evidence</h2><pre>${escapeHtml(JSON.stringify({
  candidate: review.candidate.id,
  incumbent: review.incumbent.id,
  hypothesis: review.candidate.hypothesis,
  evaluation: review.evaluation,
  workspace: view.status.workspace,
  review: review.request,
  decision: review.decision,
}, null, 2))}</pre>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DAL live review</title><style>body{max-width:960px;margin:2rem auto;padding:0 1rem;font:16px system-ui,sans-serif;color:#172033;background:#f8fafc}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;background:#fff;border:1px solid #cbd5e1;border-radius:.4rem}.button{display:inline-block;padding:.65rem .9rem;color:#fff;background:#0f766e;border-radius:.35rem;text-decoration:none}</style></head><body><h1>DAL live review</h1><p>Campaign: <code>${escapeHtml(campaign)}</code></p>${content}</body></html>`;
}

function respondJson(response: import("node:http").ServerResponse, value: unknown, attachment = false): void {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Content-Type": "application/json; charset=utf-8",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...(attachment ? { "Content-Disposition": "attachment; filename=dal-live-review-request.json" } : {}),
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

export async function serveLiveReviewDashboard(campaign: string, port = 0): Promise<LiveReviewDashboard> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new DalError("LIVE_REVIEW_PORT_INVALID", "Dashboard port must be an integer between 0 and 65535");
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET", "Cache-Control": "no-store" });
        response.end();
        return;
      }
      const view = await liveReview(campaign);
      if (path === "/api/review") {
        respondJson(response, view);
      } else if (path === "/review-request.json" && view.review !== null) {
        respondJson(response, view.review.request, true);
      } else if (path === "/") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "Content-Type": "text/html; charset=utf-8",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(renderPage(campaign, view));
      } else {
        response.writeHead(404, { "Cache-Control": "no-store" });
        response.end();
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500, { "Cache-Control": "no-store" });
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new DalError("LIVE_REVIEW_UNAVAILABLE", "Loopback dashboard did not expose a TCP port");
  }
  return { url: `http://127.0.0.1:${address.port}/`, close: () => closeServer(server) };
}

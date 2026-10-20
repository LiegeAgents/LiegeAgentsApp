import type { Reputation } from "./reputation.js";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// Verdana 11px averages about 6.5px a character; badges are sized from it, as shields-style badges are.
const textWidth = (value: string) => Math.round(value.length * 6.5) + 12;

/** What the badge says: verification first, then the recorded track record, never a rating. */
export function badgeMessage(standing: { verified: boolean; reputation: Reputation } | undefined) {
  const reputation = standing?.reputation;
  const record =
    reputation?.status === "scored"
      ? `score ${reputation.score}/100`
      : `${reputation?.outcomes ?? 0} ${reputation?.outcomes === 1 ? "job" : "jobs"} on record`;
  return standing?.verified ? `Verified · ${record}` : record;
}

/** A small two-part SVG badge for READMEs and sites, linking nowhere by itself. */
export function renderBadge(message: string, verified: boolean, agentName: string) {
  const label = "Liege";
  const left = textWidth(label);
  const right = textWidth(message);
  const width = left + right;
  const color = verified ? "#12a36f" : "#5b6470";
  const title = escape(`${agentName} on Liege: ${message}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${title}">
<title>${title}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${left}" height="20" fill="#0b0f0d"/><rect x="${left}" width="${right}" height="20" fill="${color}"/><rect width="${width}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${left / 2}" y="14" fill="#18e299">${label}</text>
<text x="${left + right / 2}" y="15" fill="#010101" fill-opacity=".3">${escape(message)}</text>
<text x="${left + right / 2}" y="14">${escape(message)}</text>
</g>
</svg>`;
}

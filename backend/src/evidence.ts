import { z } from "zod";

// Evidence links are rendered as clickable anchors, so only plain https URLs are accepted.
export function isSafeEvidenceUrl(value: unknown) {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
}

export const evidenceUrl = z
  .string()
  .max(2048)
  .refine(isSafeEvidenceUrl, "Evidence links must be https:// URLs without embedded credentials.");

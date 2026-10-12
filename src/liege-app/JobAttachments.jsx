import React, { useEffect, useRef, useState } from "react";
import { FileText, Link2, Paperclip, X } from "lucide-react";
import { Button, Notice } from "./UI";
import { api } from "./api";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json";
const MAX_FILE_BYTES = 3 * 1024 * 1024;
// Browsers often leave Markdown, CSV, and JSON untyped; the API accepts them as text.
const TEXT_TYPES = { md: "text/markdown", csv: "text/csv", txt: "text/plain", json: "text/plain" };

const size = (bytes) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Files and links the client attaches to a brief. They can change until the job is funded; after
 * that every party can still open them, and the agent reads them before it starts.
 */
export default function JobAttachments({ jobId, token, editable }) {
  const [items, setItems] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [url, setUrl] = useState(""),
    [commit, setCommit] = useState("");
  const input = useRef(null);
  const load = () =>
    api
      .jobAttachments(token, jobId)
      .then((result) => setItems(result.data || []))
      .catch(() => setItems([]));
  useEffect(() => {
    load();
  }, [jobId]);
  const run = async (kind, fn) => {
    setBusy(kind);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e?.message || "The attachment could not be saved.");
    } finally {
      setBusy("");
    }
  };
  const upload = (file) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return setError("Files can be at most 3 MB.");
    const extension = file.name.split(".").pop()?.toLowerCase();
    const typed =
      file.type && file.type !== "application/json"
        ? file
        : new File([file], file.name, { type: TEXT_TYPES[extension] || "text/plain" });
    run("file", () => api.attachFile(token, jobId, typed));
  };
  const open = async (item) => {
    setError("");
    try {
      const { data } = await api.jobAttachment(token, jobId, item.id);
      if (data.url) return window.open(data.url, "_blank", "noopener,noreferrer");
      const bytes = Uint8Array.from(atob(data.data), (char) => char.charCodeAt(0));
      const href = URL.createObjectURL(new Blob([bytes], { type: data.mediaType }));
      const link = Object.assign(document.createElement("a"), { href, download: data.name });
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) {
      setError(e?.message || "The attachment could not be opened.");
    }
  };
  if (!items?.length && !editable) return null;
  return (
    <section className="job-attachments">
      <h3>Attachments</h3>
      {error && <Notice error>{error}</Notice>}
      {items?.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              {item.kind === "link" ? <Link2 size={14} /> : <FileText size={14} />}
              <button type="button" className="attachment-name" onClick={() => open(item)}>
                {item.name}
              </button>
              {item.kind === "file" && <span className="muted">{size(item.sizeBytes)}</span>}
              {editable && (
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`Remove ${item.name}`}
                  disabled={Boolean(busy)}
                  onClick={() => run("remove", () => api.removeAttachment(token, jobId, item.id))}
                >
                  <X size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          Add up to 5 files or links for the agent: a PDF, screenshots, notes, or a GitHub repo
          pinned to a commit.
        </p>
      )}
      {editable && (items?.length ?? 0) < 5 && (
        <div className="attachment-add">
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              upload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button small secondary disabled={Boolean(busy)} onClick={() => input.current?.click()}>
            <Paperclip size={13} /> {busy === "file" ? "Uploading…" : "Attach file"}
          </Button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run("link", async () => {
                await api.attachLink(token, jobId, {
                  url: url.trim(),
                  ...(commit.trim() ? { commit: commit.trim() } : {}),
                });
                setUrl("");
                setCommit("");
              });
            }}
          >
            <input
              aria-label="Link"
              placeholder="https://github.com/owner/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <input
              aria-label="Commit (optional)"
              placeholder="commit (optional)"
              value={commit}
              onChange={(e) => setCommit(e.target.value)}
            />
            <Button small secondary type="submit" disabled={Boolean(busy) || !url.trim()}>
              {busy === "link" ? "Adding…" : "Add link"}
            </Button>
          </form>
          <p className="muted">
            PDF, images, or text up to 3 MB each. Attachments are encrypted and lock when you fund
            the job.
          </p>
        </div>
      )}
    </section>
  );
}

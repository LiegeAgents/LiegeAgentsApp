import React, { useState } from "react";
import { Star } from "lucide-react";
import { Button, Notice } from "./UI";
import { api } from "./api";

const reviewable = (status, fundedAt) =>
  ["completed", "rejected"].includes(String(status).toLowerCase()) ||
  (String(status).toLowerCase() === "expired" && Boolean(fundedAt));

export function Stars({ value, size = 14, label }) {
  return (
    <span className="review-stars" aria-label={label ?? `${value} out of 5 stars`} role="img">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={size}
          className={n <= Math.round(value) ? "on" : ""}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

/**
 * The client rates a finished job (editable for 14 days); the agent's owner answers once. Reviews
 * sit beside the agent's recorded track record and never change its score.
 */
export default function JobReview({
  jobId,
  token,
  status,
  fundedAt,
  isClient,
  isProvider,
  review,
  onSaved,
}) {
  const [rating, setRating] = useState(review?.rating ?? 0),
    [hover, setHover] = useState(0),
    [comment, setComment] = useState(review?.comment ?? ""),
    [reply, setReply] = useState(""),
    [editing, setEditing] = useState(!review),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!reviewable(status, fundedAt) || (!isClient && !isProvider)) return null;
  if (!review && !isClient) return null;
  const run = async (work) => {
    setBusy(true);
    setError("");
    try {
      await work();
      setEditing(false);
      onSaved?.();
    } catch (e) {
      setError(e?.message || "The review could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  if (isClient && editing)
    return (
      <section className="job-review">
        <h3>{review ? "Edit your review" : "Rate this work"}</h3>
        <p className="muted">
          Your rating and comment appear on the agent's profile without your name. They never change
          its track record, which comes from job outcomes only.
        </p>
        <div className="review-picker" onMouseLeave={() => setHover(0)}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
              aria-pressed={rating === n}
              onMouseEnter={() => setHover(n)}
              onClick={() => setRating(n)}
            >
              <Star size={20} className={n <= (hover || rating) ? "on" : ""} />
            </button>
          ))}
        </div>
        <textarea
          value={comment}
          maxLength={1000}
          rows={3}
          onChange={(e) => setComment(e.target.value)}
          placeholder="What went well, or what could be better? (optional)"
          aria-label="Review comment"
        />
        <div className="receipt-actions">
          <Button
            small
            disabled={busy || !rating}
            onClick={() =>
              run(() =>
                api.reviewJob(token, jobId, { rating, ...(comment.trim() ? { comment } : {}) }),
              )
            }
          >
            {busy ? "Saving…" : review ? "Save review" : "Post review"}
          </Button>
          {review && (
            <Button small secondary onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
        </div>
        {error && <Notice error>{error}</Notice>}
      </section>
    );
  return (
    <section className="job-review">
      <h3>{isClient ? "Your review" : "The client's review"}</h3>
      <Stars value={review.rating} />
      {review.comment && <p className="review-comment">“{review.comment}”</p>}
      {review.reply && (
        <p className="review-reply">
          <strong>Owner's reply:</strong> {review.reply}
        </p>
      )}
      {isClient && review.editable && (
        <Button small secondary onClick={() => setEditing(true)}>
          Edit review
        </Button>
      )}
      {isProvider && !review.reply && (
        <>
          <textarea
            value={reply}
            maxLength={1000}
            rows={2}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply publicly, once."
            aria-label="Reply to review"
          />
          <Button
            small
            disabled={busy || !reply.trim()}
            onClick={() => run(() => api.replyToReview(token, jobId, reply))}
          >
            {busy ? "Posting…" : "Post reply"}
          </Button>
        </>
      )}
      {error && <Notice error>{error}</Notice>}
    </section>
  );
}

import React, { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button, Notice } from "./UI";
import { api } from "./api";

const label = { yes: "Met", partly: "Partly met", no: "Not met" };

/**
 * An advisory grade of the delivery against each acceptance criterion. The client or evaluator
 * asks for it; it never accepts, rejects, or pays anything.
 */
export default function SecondOpinion({ jobId, token, status, canRequest }) {
  const gradable = ["submitted", "completed", "rejected", "challenged"].includes(
    String(status).toLowerCase(),
  );
  const [grade, setGrade] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!gradable) return;
    api
      .secondOpinion(token, jobId)
      .then((result) => setGrade(result.data))
      .catch(() => setGrade(null));
  }, [jobId, status]);
  if (!gradable || (!grade && !canRequest)) return null;
  const request = async () => {
    setBusy(true);
    setError("");
    try {
      setGrade((await api.requestSecondOpinion(token, jobId)).data);
    } catch (e) {
      setError(e?.message || "The grade could not be made.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="second-opinion">
      <h3>
        <Sparkles size={15} /> Second opinion
      </h3>
      {grade ? (
        <>
          <p>
            <strong>{grade.score}/100</strong> · {grade.summary}
          </p>
          <ul className="rule-results">
            {grade.criteria.map((item, index) => (
              <li key={index} className={item.met === "yes" ? "ok" : item.met === "no" ? "bad" : ""}>
                <span>
                  <strong>{label[item.met]}</strong> · {item.criterion}: {item.reason}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">Advice from {grade.model}, not a decision. You still decide.</p>
        </>
      ) : (
        <>
          <p className="muted">
            Have an AI grader check the delivery against each acceptance criterion before you
            decide. The brief and delivery are sent to the grading model; the result only advises.
          </p>
          {error && <Notice error>{error}</Notice>}
          <Button small secondary onClick={request} disabled={busy}>
            {busy ? "Grading…" : "Get a second opinion"}
          </Button>
        </>
      )}
    </section>
  );
}

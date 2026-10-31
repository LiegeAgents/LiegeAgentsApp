import React, { useEffect, useState } from "react";
import { Field } from "./UI";
import { api } from "./api";

const duration = (minutes) =>
  minutes >= 1440
    ? `${Math.round(minutes / 1440)} d`
    : minutes >= 60
      ? `${Math.round(minutes / 60)} h`
      : `${minutes} min`;

/**
 * Picks a Super Agent that can be hired now in `asset`: enrolled, verified, and reachable. Shows
 * the chosen agent's service, listed price, delivery time, and track record, and clears the
 * choice when the asset changes to one the agent does not take.
 */
export default function SuperAgentPicker({ asset, value, onChange }) {
  const [agents, setAgents] = useState(null);
  useEffect(() => {
    let stopped = false;
    api
      .hireableSuperAgents(asset)
      .then((result) => {
        if (stopped) return;
        setAgents(result.data);
        if (value && !result.data.some((agent) => agent.id === value)) onChange("");
      })
      .catch(() => !stopped && setAgents([]));
    return () => {
      stopped = true;
    };
  }, [asset]);
  const chosen = agents?.find((agent) => agent.id === value);
  return (
    <>
      <Field label="Super Agent">
        <select value={value} onChange={(e) => onChange(e.target.value)} disabled={!agents}>
          <option value="">
            {!agents
              ? "Loading…"
              : agents.length
                ? "Choose an agent"
                : `No Super Agents take ${asset.toUpperCase()} right now`}
          </option>
          {(agents || []).map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name} · {agent.serviceName}
            </option>
          ))}
        </select>
      </Field>
      {chosen && (
        <p className="muted super-agent-pick">
          {chosen.description} Lists at ${chosen.priceUsd} a job, delivers in about{" "}
          {duration(chosen.slaMinutes)}.{" "}
          {chosen.reputation?.score != null
            ? `Track record ${chosen.reputation.score}/100 over ${chosen.reputation.outcomes} jobs.`
            : chosen.reputation?.outcomes
              ? `${chosen.reputation.outcomes} recorded jobs so far.`
              : "No recorded jobs yet."}
        </p>
      )}
    </>
  );
}

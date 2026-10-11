// The most recent provider-reported milestone for the job aliased `jobAlias`, as a JSON column
// named `progress` (null before the agent reports anything).
export const latestProgressColumn = (jobAlias: string) =>
  `(SELECT json_build_object('stage', p.stage, 'message', p.message, 'percent', p.percent, 'created_at', p.created_at)
    FROM job_progress p WHERE p.job_id = ${jobAlias}.id ORDER BY p.created_at DESC, p.id DESC LIMIT 1) AS progress`;

// Enough for a step-by-step trail without letting a runtime flood a client's view.
export const MAX_PROGRESS_UPDATES = 30;

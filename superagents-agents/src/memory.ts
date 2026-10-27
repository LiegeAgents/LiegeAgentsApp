export type ClientMemory = {
  enabled: boolean;
  preferences: string | null;
  learned: Array<{ jobTitle: string; feedback: string }>;
};

/**
 * What the agent remembers about this client, as a block appended to the brief: the client's
 * stated preferences and their feedback on earlier jobs. It is the client's own words, so it is
 * framed as their data, and the brief stays the authority for this job.
 */
export function memoryNote(memory: ClientMemory | null) {
  if (!memory?.enabled || (!memory.preferences && !memory.learned.length)) return "";
  const lines = [
    "",
    "<client_memory>",
    "What this client has told you before. Follow it where it fits; this job's brief wins if they conflict.",
  ];
  if (memory.preferences) lines.push(`Their standing preferences: ${memory.preferences}`);
  for (const item of memory.learned)
    lines.push(`Their revision feedback on "${item.jobTitle}": ${item.feedback}`);
  lines.push("</client_memory>");
  return lines.join("\n");
}

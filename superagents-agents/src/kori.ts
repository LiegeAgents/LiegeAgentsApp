import { generate } from "./groq.js";
import type { SuperAgentHandler } from "./types.js";

export const koriServiceSlugs = ["customer-support"];

export const koriSystemPrompt = `You are Kori by LiegeAgents, a customer service agent operated by the Liege team.

Your job: the brief contains a customer's message, and it may also include context from the business you are answering for, such as product details, policies, or order information. Write the reply you would send to that customer.

Identity:
- Speak in first person. If someone asks who you are, say you are Kori and that you help with customer questions. Never describe yourself in the third person or like a product brochure.
- If a customer sincerely asks whether they are talking to a human, be honest that you are Kori, an AI agent run by the Liege team.

How you sound:
- Calm: keep a steady, patient tone, even when the customer is frustrated or the problem is serious. Treat every issue as something you work through together.
- Warm and polite: acknowledge how the customer feels in one short sentence, then help. Do not over-apologize or gush.
- Direct: answer the actual question first, in plain language. No corporate filler such as "We are thrilled", "valued customer", "rest assured", or "Exciting news".
- Gently friendly humor: you may add one mild, kind joke or light remark when the customer's mood is relaxed. Never joke when the customer is upset, has lost money, or reports a security or account problem. Never use sarcasm, teasing, roasting, slang, or anything at the customer's expense.
- Never harsh: no blaming, no condescension, and no harsh words, even if the customer is rude. Stay kind and keep helping.

Honesty and limits:
- Use only facts given in the brief. Never invent policies, prices, timelines, refund terms, order details, links, or contact details.
- If you do not have the information needed to resolve the issue, say so plainly and kindly, and tell the customer exactly what detail you need or who can help.
- Never claim an action you did not perform. You have not issued refunds, changed accounts, escalated tickets, or sent emails. You may explain what the next step is.
- You cannot look up orders, accounts, tracking, or any other records, and you will not see the customer's next message. Never promise to check, look into, investigate, or follow up on anything (for example, never say "once you send that, I can look into it"). If details are missing, tell the customer what to send and to whom, as stated in the brief, or say the support team will need it.
- Never ask for passwords, private keys, seed phrases, one-time codes, or full card numbers.
- If the brief contains [REDACTED_SECRET], the customer shared something sensitive. Kindly tell them it was not used, that they should never share it with anyone, and that they should treat it as exposed (for example, move funds to a new wallet or rotate the key or password).

Format:
- Standard capitalization and punctuation.
- Zero emojis. No em dashes or en dashes; use commas, periods, colons, or simple hyphens.
- Short paragraphs. Use numbered steps only when walking the customer through steps. No tables.
- Keep it concise, usually two to five short paragraphs.
- Greet the customer by name if the brief gives one, and sign off as Kori.
- End with at most one short, friendly closing line. No capability menus and no pushy offers.
- Output only the reply to the customer. No preamble such as "Here is the reply", and no notes about the brief.`;

// Credentials customers sometimes paste into tickets. A bare 64-hex value is treated as a
// private key; 0x-prefixed values are left intact because customers often paste transaction hashes.
const secretPatterns = [
  /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY-----|$)/gi,
  /\b(?:ghp_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}|sk_live_[a-zA-Z0-9]{20,}|sk_test_[a-zA-Z0-9]{20,}|xox[baprs]-[0-9a-zA-Z-]{10,}|AKIA[0-9A-Z]{16}|re_[a-zA-Z0-9_]{20,}|AIza[0-9A-Za-z_-]{35})/g,
  /\bbearer\s+[a-zA-Z0-9_\-.]{25,}/gi,
  /(?<![a-zA-Z0-9])(?<!0x)[a-fA-F0-9]{64}(?![a-zA-Z0-9])/g,
  /\b(?:seed|recovery|secret)\s+phrase\b[^a-z\n]*((?:[a-z]+\s+){11,23}[a-z]+)/gi,
  /\bmnemonic\b[^a-z\n]*((?:[a-z]+\s+){11,23}[a-z]+)/gi,
];

export function redactSecrets(text: string) {
  let count = 0;
  let redacted = text;
  for (const pattern of secretPatterns)
    redacted = redacted.replace(pattern, (match, phrase?: string) => {
      count++;
      return typeof phrase === "string" ? match.replace(phrase, "[REDACTED_SECRET]") : "[REDACTED_SECRET]";
    });
  return { text: redacted, count };
}

export function cleanReply(raw: string) {
  return raw
    .replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/gi, "")
    .replace(/\s*[—–]\s*/g, " - ")
    .trim();
}

export function createKoriHandler(generateReply: typeof generate = generate): SuperAgentHandler {
  return {
    agentKey: "kori",
    serviceSlugs: koriServiceSlugs,
    async execute({ jobId, brief, requirements }) {
      const { text, count } = redactSecrets(brief);
      const policy = (requirements ?? {}) as Record<string, unknown>;
      const serviceSlug = typeof policy.serviceSlug === "string" ? policy.serviceSlug : koriServiceSlugs[0];
      const raw = await generateReply(koriSystemPrompt, `Job ID: ${jobId}\nService: ${serviceSlug}\nCustomer message and context:\n${text} /no_think`);
      const deliverable = cleanReply(raw);
      if (!deliverable) throw new Error("Kori returned an empty reply.");
      return { deliverable, metadata: { model: "groq", agentKey: "kori", serviceSlug, redactedSecrets: count } };
    },
  };
}

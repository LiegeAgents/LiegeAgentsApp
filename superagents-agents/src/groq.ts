import { config } from "./config.js";

type Image = { mediaType: string; data: string };

async function complete(model: string, system: string, user: string | unknown[], json = false) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${config.groqKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: config.groqMaxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(config.groqTimeoutMs),
  });
  const body = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(body.error?.message ?? `Groq returned ${response.status}.`);
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Groq returned an empty response.");
  return content;
}

/**
 * Generates a deliverable. Attached images go to the vision model; if it cannot take them, the
 * text model answers without the images and is told they could not be viewed.
 */
export async function generate(system: string, user: string, images: Image[] = []) {
  if (!images.length) return complete(config.groqModel, system, user);
  try {
    return await complete(config.groqVisionModel, system, [
      { type: "text", text: user },
      ...images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mediaType};base64,${image.data}` },
      })),
    ]);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "vision.fallback",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return complete(
      config.groqModel,
      system,
      `${user}\n\n(The ${images.length} attached image${images.length === 1 ? "" : "s"} could not be viewed; say so where it matters.)`,
    );
  }
}

/** A JSON object from the text model, for structured output such as code edits. */
export async function generateJson(system: string, user: string): Promise<unknown> {
  const content = await complete(config.groqModel, system, user, true);
  // Reasoning models may wrap the object in a think block or a code fence.
  const body = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, "");
  return JSON.parse(body);
}

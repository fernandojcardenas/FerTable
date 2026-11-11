// AI fields: write one cell's text with an AI model through the Anthropic API. Runs on the
// server only, so the API key never reaches a browser. Set ANTHROPIC_API_KEY (or sign in with
// `ant auth login`) and FERTABLE_AI_MODEL (the model id to use).

import Anthropic from "@anthropic-ai/sdk";

/** Model for AI fields, from FERTABLE_AI_MODEL. AI fields stay off until it is set. */
export const AI_MODEL = process.env.FERTABLE_AI_MODEL?.trim() ?? "";

const SYSTEM = [
  "You fill in one cell of a spreadsheet-style database.",
  "Reply with only the cell's content: no preamble, no quotation marks around it, no markdown headings.",
  "Keep it short unless the instructions ask for more.",
].join(" ");

export type AiResult = { text: string } | { error: string };

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** Ask the AI model for one cell's content. Never throws: problems come back as { error }. */
export async function generateCell(prompt: string): Promise<AiResult> {
  if (!prompt.trim()) return { error: "This AI field has no prompt yet" };
  // For tests and demos without an API key: answers without calling the API.
  if (process.env.FERTABLE_AI_FAKE === "1") return { text: `AI: ${prompt.trim().slice(0, 200)}` };
  if (!AI_MODEL) return { error: "AI isn't set up on this server (set FERTABLE_AI_MODEL)" };
  try {
    const response = await getClient().beta.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: "low" },
      // If this model declines, the API retries on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") return { error: "The AI declined to answer this prompt" };
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (response.stop_reason === "max_tokens") return { text: `${text}…` };
    return text ? { text } : { error: "The AI returned an empty answer" };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { error: "AI isn't set up on this server: the API key was rejected" };
    if (e instanceof Anthropic.RateLimitError) return { error: "The AI service is busy; try again in a minute" };
    if (e instanceof Anthropic.BadRequestError) return { error: `The AI couldn't use this prompt: ${e.message.slice(0, 200)}` };
    if (e instanceof Anthropic.APIError) return { error: `The AI service had a problem (${e.status ?? "network"})` };
    // No credentials at all, or a network problem before any response.
    const msg = e instanceof Error ? e.message : String(e);
    if (/api.?key|credential|auth/i.test(msg)) return { error: "AI isn't set up on this server (set ANTHROPIC_API_KEY)" };
    return { error: `The AI service couldn't be reached: ${msg.slice(0, 160)}` };
  }
}

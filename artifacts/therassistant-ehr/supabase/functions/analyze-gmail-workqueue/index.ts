// @ts-expect-error - Deno edge runtime URL import is valid at runtime but not resolvable by this TS config.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getOutputText(aiJson: any): string | null {
  if (typeof aiJson.output_text === "string") return aiJson.output_text;

  for (const item of aiJson.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return null;
}

serve(async () => {
  const result = {
    checked: 0,
    analyzed: 0,
    failed: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    results: [] as any[],
  };

  const { data: emails, error } = await supabase
    .from("inbound_email_messages")
    .select(`
      id,
      organization_id,
      from_email,
      from_name,
      subject,
      snippet,
      raw_payload,
      workqueue_item_id
    `)
    .eq("provider", "gmail")
    .eq("processing_status", "routed")
    .eq("ai_analysis_status", "pending")
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  result.checked = emails?.length ?? 0;

  for (const email of emails ?? []) {
    try {
      const emailText = `
From: ${email.from_name ?? ""} <${email.from_email}>
Subject: ${email.subject ?? ""}
Snippet: ${email.snippet ?? ""}

Raw excerpt:
${JSON.stringify(email.raw_payload ?? {}).slice(0, 6000)}
`;

      const aiRes = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: [
            {
              role: "system",
              content:
                "You analyze inbound healthcare operations emails for an EHR mailroom. Return only valid JSON. Never say a task is complete. Draft replies must be reviewed by staff before sending.",
            },
            {
              role: "user",
              content:
                "Analyze this email. Categorize it, summarize it, determine priority, and draft a professional reply.\n\n" +
                emailText,
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "gmail_workqueue_analysis",
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  sentiment: {
                    type: "string",
                    enum: ["positive", "neutral", "negative", "angry", "confused"],
                  },
                  sentiment_score: {
                    type: "number",
                  },
                  category: {
                    type: "string",
                    enum: [
                      "claims_denial",
                      "address_change",
                      "authorization",
                      "eligibility",
                      "payment",
                      "clinical",
                      "scheduling",
                      "admin",
                      "complaint",
                      "urgent_response",
                      "other",
                    ],
                  },
                  priority: {
                    type: "string",
                    enum: ["low", "normal", "high"],
                  },
                  summary: {
                    type: "string",
                  },
                  draft_reply: {
                    type: "string",
                  },
                },
                required: [
                  "sentiment",
                  "sentiment_score",
                  "category",
                  "priority",
                  "summary",
                  "draft_reply",
                ],
              },
            },
          },
        }),
      });

      if (!aiRes.ok) {
        throw new Error(await aiRes.text());
      }

      const aiJson = await aiRes.json();
      const outputText = getOutputText(aiJson);

      if (!outputText) {
        throw new Error("No AI output_text returned");
      }

      const analysis = JSON.parse(outputText);

      const { error: updateEmailError } = await supabase
        .from("inbound_email_messages")
        .update({
          ai_sentiment: analysis.sentiment,
          ai_sentiment_score: analysis.sentiment_score,
          ai_category: analysis.category,
          ai_priority: analysis.priority,
          ai_summary: analysis.summary,
          ai_draft_reply: analysis.draft_reply,
          ai_analysis_status: "analyzed",
          ai_analyzed_at: new Date().toISOString(),
          ai_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", email.id);

      if (updateEmailError) throw updateEmailError;

      if (email.workqueue_item_id) {
        const { data: existing, error: existingError } = await supabase
          .from("workqueue_items")
          .select("context_payload")
          .eq("id", email.workqueue_item_id)
          .single();

        if (existingError) throw existingError;

        const mergedPayload = {
          ...(existing?.context_payload ?? {}),
          ai_sentiment: analysis.sentiment,
          ai_sentiment_score: analysis.sentiment_score,
          ai_category: analysis.category,
          ai_summary: analysis.summary,
          ai_draft_reply: analysis.draft_reply,
          inbound_email_message_id: email.id,
          from_email: email.from_email,
          subject: email.subject,
        };

        const { error: updateWorkqueueError } = await supabase
          .from("workqueue_items")
          .update({
            priority: analysis.priority,
            title: `[${analysis.category}] ${email.subject ?? "Gmail message"}`.slice(0, 200),
            description: analysis.summary,
            context_payload: mergedPayload,
            updated_at: new Date().toISOString(),
          })
          .eq("id", email.workqueue_item_id);

        if (updateWorkqueueError) throw updateWorkqueueError;
      }

      result.analyzed += 1;
      result.results.push({
        id: email.id,
        status: "analyzed",
        category: analysis.category,
        priority: analysis.priority,
      });
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = String((err as any)?.message ?? err);

      await supabase
        .from("inbound_email_messages")
        .update({
          ai_analysis_status: "failed",
          ai_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", email.id);

      result.failed += 1;
      result.results.push({
        id: email.id,
        status: "failed",
        error: message,
      });
    }
  }

  return Response.json(result);
});
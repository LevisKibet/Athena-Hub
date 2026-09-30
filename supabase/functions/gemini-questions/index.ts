// Supabase Edge Function: gemini-questions
//
// Holds the Gemini API key server-side (as a Supabase secret) so it is never
// shipped to the browser. The client calls this function via
// supabaseClient.functions.invoke('gemini-questions', { body: { ... } }).
//
// Two actions:
//   - "extract":  pull multiple-choice questions out of an uploaded PDF
//                 (sent as base64) or already-extracted document text
//                 (e.g. from a .docx read client-side with mammoth.js).
//   - "generate": write brand-new multiple-choice questions from a topic
//                 prompt, question count, and difficulty.
//
// Deploy with:
//   supabase secrets set GEMINI_API_KEY=your_key_here --project-ref <ref>
//   supabase functions deploy gemini-questions --project-ref <ref>
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Supabase Edge Functions runtime — you do not need to set those two.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

// Double-check this is still the current model name/version on
// https://ai.google.dev/gemini-api/docs/models before deploying —
// Google updates these periodically.
const GEMINI_MODEL = 'gemini-2.5-flash';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const QUESTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          question: { type: 'STRING' },
          option_a: { type: 'STRING' },
          option_b: { type: 'STRING' },
          option_c: { type: 'STRING' },
          option_d: { type: 'STRING' },
          correct: { type: 'STRING', enum: ['A', 'B', 'C', 'D'] },
          image_query: {
            type: 'STRING',
            description: 'A short 2-4 word search phrase for a real photo that visually represents this question, e.g. "Eiffel Tower Paris" or "golden retriever dog".',
          },
        },
        required: ['question', 'option_a', 'option_b', 'option_c', 'option_d', 'correct', 'image_query'],
      },
    },
  },
  required: ['questions'],
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured on the server.');
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Supabase service credentials are not configured.');
    }

    // Identify the caller from their real Supabase Auth session, sent
    // automatically as a Bearer token by supabaseClient.functions.invoke()
    // once they're signed in — never trust a client-supplied user id here.
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return jsonResponse({ error: 'You must be signed in to do this.' }, 401);

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData || !userData.user) {
      return jsonResponse({ error: 'You must be signed in to do this.' }, 401);
    }
    const callerId = userData.user.id;

    const body = await req.json();
    const { action, game_id } = body;

    if (!game_id) {
      return jsonResponse({ error: 'game_id is required.' }, 400);
    }

    // Verify the caller actually owns this match before spending API quota
    // on their behalf. Uses the service role key, so this check can't be
    // bypassed by RLS being off/on client-side.
    const { data: game, error: gameErr } = await supabaseAdmin
      .from('games')
      .select('host_token')
      .eq('id', game_id)
      .single();

    if (gameErr || !game) return jsonResponse({ error: 'Match not found.' }, 404);
    if (game.host_token !== callerId) return jsonResponse({ error: 'You do not own this match.' }, 403);

    let questions;
    if (action === 'extract') {
      questions = await extractFromFile(body);
    } else if (action === 'generate') {
      questions = await generateFromPrompt(body);
    } else {
      return jsonResponse({ error: 'Unknown action. Use "extract" or "generate".' }, 400);
    }

    // Give each question a real, verified photo instead of trusting a URL
    // Gemini might invent. Gemini only supplies a short search phrase
    // (image_query); we look that up against Wikipedia's free, keyless API
    // and only use the result if an actual thumbnail comes back.
    questions = await Promise.all(questions.map(async (q: any) => {
      const { image_query, ...rest } = q;
      const imageUrl = await fetchImageForQuery(image_query || q.question);
      return { ...rest, image_url: imageUrl || '' };
    }));

    return jsonResponse({ questions });
  } catch (err) {
    console.error('gemini-questions error:', err);
    return jsonResponse({ error: err instanceof Error ? err.message : 'Unexpected error.' }, 500);
  }
});

async function extractFromFile(body: any) {
  const { file_base64, mime_type, document_text, max_questions } = body;

  const limitInstruction = max_questions
    ? `Extract up to ${max_questions} multiple-choice trivia questions from this document.`
    : 'Extract every multiple-choice trivia question you can find in this document.';

  const instructions = `${limitInstruction} If the document text isn't already in a clean multiple-choice format, rewrite it into one question, four plausible distinct answer options (A-D), and mark which single option is correct. Keep each question and option concise (under 120 characters). Only return real questions found or clearly derivable from the document content, in the order they appear.`;

  if (document_text) {
    // Word docs are extracted to plain text client-side (mammoth.js) before
    // reaching this function, since Gemini can't parse the raw .docx binary.
    const trimmed = String(document_text).slice(0, 50000);
    return callGemini([{ text: `${instructions}\n\nDocument content:\n"""\n${trimmed}\n"""` }]);
  }

  if (file_base64 && mime_type) {
    // PDFs are natively understood by Gemini as inline document data.
    return callGemini([
      { inline_data: { mime_type, data: file_base64 } },
      { text: instructions },
    ]);
  }

  throw new Error('Provide either file_base64+mime_type (PDF) or document_text (Word doc extracted client-side).');
}

async function generateFromPrompt(body: any) {
  const { topic, count, difficulty } = body;
  if (!topic) throw new Error('topic is required for generation.');

  const n = Math.max(1, Math.min(30, Number(count) || 5));
  const level = ['easy', 'medium', 'hard'].includes(String(difficulty || '').toLowerCase())
    ? String(difficulty).toLowerCase()
    : 'medium';

  const instructions = `Generate exactly ${n} original multiple-choice trivia questions about "${topic}" at a ${level} difficulty level. Each question needs four distinct, plausible answer options (A-D) with exactly one correct answer. Keep each question and option concise (under 120 characters). Avoid duplicate questions or near-duplicate options.`;

  return callGemini([{ text: instructions }]);
}

async function callGemini(parts: any[]) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        response_mime_type: 'application/json',
        response_schema: QUESTION_SCHEMA,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Gemini returned malformed JSON.');
  }

  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  if (questions.length === 0) throw new Error('No questions were found or generated.');

  return questions.map((q: any) => ({
    question: String(q.question || '').slice(0, 300),
    option_a: String(q.option_a || '').slice(0, 150),
    option_b: String(q.option_b || '').slice(0, 150),
    option_c: String(q.option_c || '').slice(0, 150),
    option_d: String(q.option_d || '').slice(0, 150),
    correct: ['A', 'B', 'C', 'D'].includes(String(q.correct || '').toUpperCase())
      ? String(q.correct).toUpperCase()
      : 'A',
    image_query: String(q.image_query || '').slice(0, 100),
  }));
}

// Looks up a real image via Wikipedia's public search API (no key required,
// CORS-open). Returns null if nothing suitable is found, so callers can fall
// back to a default image rather than ever serving a broken/hallucinated URL.
async function fetchImageForQuery(query: string): Promise<string | null> {
  const q = String(query || '').trim();
  if (!q) return null;

  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=1&prop=pageimages&piprop=thumbnail&pithumbsize=500&origin=*`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const pages = data && data.query && data.query.pages;
    if (!pages) return null;

    const first = Object.values(pages)[0] as any;
    return (first && first.thumbnail && first.thumbnail.source) || null;
  } catch {
    return null;
  }
}

function jsonResponse(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

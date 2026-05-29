// OpenRouter client — runs on the main thread (no worker needed). Streams a chat
// completion from the OpenAI-compatible /chat/completions endpoint over SSE.
//
// The browser calls OpenRouter directly: the API is CORS-enabled and the user's
// key is their own (BYO-key), stored only in this browser's localStorage. Nothing
// here touches transformers.js or the worker.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';

export type FreeModel = { id: string; name: string };

type RawModel = {
  id: string;
  name?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string; // legacy "text+image->text"
  };
};

// Resolve input/output modalities, falling back to the legacy "in->out" string.
function modalitiesOf(a: RawModel['architecture']) {
  let inputs = a?.input_modalities;
  let outputs = a?.output_modalities;
  if ((!inputs || !outputs) && typeof a?.modality === 'string') {
    const [inp, out] = a.modality.split('->');
    inputs = inputs ?? (inp ? inp.split('+') : []);
    outputs = outputs ?? (out ? out.split('+') : []);
  }
  return { inputs: inputs ?? [], outputs: outputs ?? [] };
}

// Keep only models that fit the task: free, accept image input (to read the
// pages), and produce text output (the review).
//
// "Free" = OpenRouter's canonical ":free" suffix. A pricing-based guess
// (prompt/completion == "0") wrongly catches models billed per other units —
// e.g. Lyria (music) is priced per second, so its token prices read 0 and it
// outputs audio, not text.
export function filterFreeVisionModels(data: RawModel[]): FreeModel[] {
  return data
    .filter((m) => {
      if (!m.id.endsWith(':free')) return false;
      const { inputs, outputs } = modalitiesOf(m.architecture);
      return inputs.includes('image') && outputs.includes('text');
    })
    .map((m) => ({ id: m.id, name: m.name ?? m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Fetch the catalogue and keep the free image->text models. The public /models
// endpoint is CORS-enabled and needs no auth, but we send the key if we have one.
// Failures are non-fatal: the caller just falls back to manual entry.
export async function fetchFreeModels(apiKey?: string): Promise<FreeModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(MODELS_ENDPOINT, { headers });
  if (!res.ok) throw new Error(`OpenRouter /models failed (${res.status})`);
  const json = (await res.json()) as { data?: RawModel[] };
  return filterFreeVisionModels(json.data ?? []);
}


export type OpenRouterOptions = {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  imageDataUrls: string[];
  signal: AbortSignal;
  onToken: (text: string) => void;
};

export type OpenRouterResult = { tokens: number; elapsedMs: number; interrupted: boolean };

// Friendly, actionable messages for the common failure modes the free tier hits.
function statusMessage(status: number, body: string): string {
  switch (status) {
    case 401:
      return 'OpenRouter rejected the API key (401). Open settings (⚙) and check your key.';
    case 402:
      return 'OpenRouter says this account is out of credits (402). Free models should be free — check your account at openrouter.ai.';
    case 429:
      return "Rate limited by OpenRouter (429). Free models are capped (~20/min, ~200/day) — wait a bit and try again.";
    default:
      return `OpenRouter request failed (${status}). ${body.slice(0, 300)}`;
  }
}

export async function runOpenRouter(opts: OpenRouterOptions): Promise<OpenRouterResult> {
  const messages = [
    { role: 'system', content: opts.systemPrompt },
    {
      role: 'user',
      content: [
        ...opts.imageDataUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        { type: 'text' as const, text: opts.userPrompt },
      ],
    },
  ];

  const start = performance.now();

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: opts.signal,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter's recommended app-attribution headers.
        'HTTP-Referer': location.origin,
        'X-Title': 'Reviewer 2',
      },
      body: JSON.stringify({ model: opts.model, messages, stream: true }),
    });
  } catch (err) {
    if (opts.signal.aborted) return { tokens: 0, elapsedMs: performance.now() - start, interrupted: true };
    throw new Error(
      `Could not reach OpenRouter. Check your connection.\n\n${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(statusMessage(res.status, body));
  }
  if (!res.body) throw new Error('OpenRouter returned an empty response stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let tokens = 0;

  // SSE frames are separated by blank lines; a frame may carry one or more
  // `data:` lines. We accumulate text and process complete lines as they arrive.
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);

        if (line === '' || line.startsWith(':')) continue; // keep-alive / comment
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          return { tokens, elapsedMs: performance.now() - start, interrupted: false };
        }
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const chunk = json.choices?.[0]?.delta?.content;
          if (chunk) {
            tokens += 1;
            opts.onToken(chunk);
          }
        } catch {
          // Partial JSON across chunk boundaries is rare with line-buffering, but
          // ignore any unparseable frame rather than aborting the whole stream.
        }
      }
    }
  } catch (err) {
    if (opts.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return { tokens, elapsedMs: performance.now() - start, interrupted: true };
    }
    throw err;
  }

  return { tokens, elapsedMs: performance.now() - start, interrupted: false };
}

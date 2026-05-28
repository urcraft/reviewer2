import { TextStreamer, RawImage } from '@huggingface/transformers';
import type { LoadedModel } from './models';
import { REVIEWER_2_SYSTEM_PROMPT, REVIEWER_2_USER_PROMPT } from './prompts';
import { debugBus } from './debug';

export type ReviewStats = {
  tokens: number;
  elapsedMs: number;
  tokensPerSec: number;
};

export type ReviewCallbacks = {
  onToken: (chunk: string) => void;
  onStats: (stats: ReviewStats) => void;
};

export async function runReview(
  loaded: LoadedModel,
  canvases: OffscreenCanvas[],
  { onToken, onStats }: ReviewCallbacks,
): Promise<void> {
  const { processor, model } = loaded;

  const images = canvases.map((c) => RawImage.fromCanvas(c));

  const messages = [
    { role: 'system', content: REVIEWER_2_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        ...images.map(() => ({ type: 'image' as const })),
        { type: 'text' as const, text: REVIEWER_2_USER_PROMPT },
      ],
    },
  ];

  debugBus.info(`processor: apply_chat_template (${images.length} image(s))`);
  const proc = processor as unknown as {
    apply_chat_template: (msgs: unknown, opts: Record<string, unknown>) => string;
    tokenizer: unknown;
    (text: string, images: RawImage[]): Promise<Record<string, unknown>>;
  };
  const text = proc.apply_chat_template(messages, { add_generation_prompt: true });

  debugBus.info(`processor: encoding text + images`);
  const inputs = await (proc as unknown as (t: string, i: RawImage[]) => Promise<Record<string, unknown>>)(
    text,
    images,
  );

  const start = performance.now();
  let tokenCount = 0;
  const streamer = new TextStreamer(proc.tokenizer as never, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk: string) => {
      tokenCount += 1;
      onToken(chunk);
      const elapsedMs = performance.now() - start;
      onStats({
        tokens: tokenCount,
        elapsedMs,
        tokensPerSec: tokenCount / (elapsedMs / 1000),
      });
    },
  });

  debugBus.info('generate: starting');
  await (model as unknown as {
    generate: (args: Record<string, unknown>) => Promise<unknown>;
  }).generate({
    ...inputs,
    max_new_tokens: 1024,
    do_sample: false,
    streamer,
  });

  const elapsedMs = performance.now() - start;
  debugBus.info(
    `generate: done · ${tokenCount} tokens · ${(elapsedMs / 1000).toFixed(1)}s · ${(tokenCount / (elapsedMs / 1000)).toFixed(1)} tok/s`,
  );
}

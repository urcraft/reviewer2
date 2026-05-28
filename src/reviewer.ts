import { TextStreamer } from '@huggingface/transformers';
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
  images: ImageBitmap[],
  { onToken, onStats }: ReviewCallbacks,
): Promise<void> {
  const { processor, model } = loaded;

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

  debugBus.info(`processor: encoding ${images.length} image(s) + prompt`);
  const inputs = await (processor as unknown as (
    images: ImageBitmap[],
    messages: unknown,
    opts: { add_generation_prompt: boolean },
  ) => Promise<Record<string, unknown>>)(images, messages, { add_generation_prompt: true });

  const start = performance.now();
  let tokenCount = 0;
  const tokenizer = (processor as unknown as { tokenizer: unknown }).tokenizer;
  const streamer = new TextStreamer(tokenizer as never, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => {
      tokenCount += 1;
      onToken(text);
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

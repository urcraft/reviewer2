import {
  AutoProcessor,
  AutoModelForImageTextToText,
  Gemma4ForConditionalGeneration,
  Lfm2VlForConditionalGeneration,
  TextStreamer,
  InterruptableStoppingCriteria,
  RawImage,
} from '@huggingface/transformers';
import { findModel, type ModelClassId } from './model-registry';
import type {
  WorkerRequest,
  WorkerResponse,
  LoadRequest,
  GenerateRequest,
  PageImage,
} from './worker-protocol';

const MODEL_CLASSES: Record<ModelClassId, typeof AutoModelForImageTextToText> = {
  Gemma4ForConditionalGeneration: Gemma4ForConditionalGeneration as unknown as typeof AutoModelForImageTextToText,
  Lfm2VlForConditionalGeneration: Lfm2VlForConditionalGeneration as unknown as typeof AutoModelForImageTextToText,
  AutoModelForImageTextToText,
};

type Loaded = {
  key: string;
  processor: unknown;
  model: unknown;
};

let loaded: Loaded | null = null;
let stopping: InterruptableStoppingCriteria | null = null;

function post(msg: WorkerResponse) {
  (self as unknown as Worker).postMessage(msg);
}

function log(level: 'info' | 'warn' | 'error', message: string) {
  post({ type: 'log', level, message });
}

function isWebGpuError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /WebGPU|valid external Instance|compute pipeline|GPUDevice|gpu/i.test(msg);
}

async function handleLoad({ modelId, dtype, device }: LoadRequest) {
  const entry = findModel(modelId);
  const key = `${modelId}|${dtype}|${device}`;
  if (loaded && loaded.key === key) {
    post({ type: 'loaded' });
    return;
  }

  // Dispose the previous model so its ORT sessions + GPU buffers are released
  // before we allocate the next one. Otherwise the old weights linger in VRAM
  // and the next load fights for the leftover budget.
  if (loaded) {
    try {
      const prev = loaded.model as { dispose?: () => Promise<void> | void };
      if (typeof prev.dispose === 'function') {
        await prev.dispose();
        log('info', 'previous model disposed');
      }
    } catch (e) {
      log('warn', `dispose failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    loaded = null;
  }

  log('info', `model: loading ${modelId} (dtype ${dtype}, device ${device})`);

  const onProgress = (info: {
    status: string;
    file?: string;
    loaded?: number;
    total?: number;
  }) => {
    if (info.status === 'progress' && info.file) {
      post({
        type: 'progress',
        file: info.file,
        loaded: info.loaded ?? 0,
        total: info.total ?? 0,
      });
    } else if (info.status === 'initiate' && info.file) {
      log('info', `download: starting ${info.file}`);
    } else if ((info.status === 'done' || info.status === 'ready') && info.file) {
      log('info', `download: ${info.file} done`);
    }
  };

  try {
    const processor = await AutoProcessor.from_pretrained(modelId, {
      progress_callback: onProgress as never,
    });
    const ModelClass = MODEL_CLASSES[entry.modelClass];
    const model = await ModelClass.from_pretrained(modelId, {
      dtype: dtype as never,
      device: device as never,
      progress_callback: onProgress as never,
    });
    loaded = { key, processor, model };
    log('info', `model: loaded ${modelId} on ${device}/${dtype}`);
    post({ type: 'loaded' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', `model load failed: ${message}`);
    post({ type: 'loadError', message, isWebGpu: isWebGpuError(err) });
  }
}

async function handleGenerate(req: GenerateRequest) {
  if (!loaded) {
    post({ type: 'generateError', message: 'No model loaded.', isWebGpu: false });
    return;
  }
  const { processor, model } = loaded;

  const images = req.images.map(
    (p: PageImage) => new RawImage(p.data, p.width, p.height, 4),
  );

  const messages = [
    {
      role: 'user',
      content: [
        ...images.map(() => ({ type: 'image' as const })),
        { type: 'text' as const, text: `${req.systemPrompt}\n\n---\n\n${req.userPrompt}` },
      ],
    },
  ];

  try {
    const proc = processor as {
      apply_chat_template: (m: unknown, o: Record<string, unknown>) => string;
      tokenizer: unknown;
    };
    log('info', `processor: apply_chat_template (${images.length} image(s))`);
    const text = proc.apply_chat_template(messages, { add_generation_prompt: true });

    log('info', 'processor: encoding text + images');
    const inputs = await (processor as unknown as (
      t: string,
      i: RawImage[],
    ) => Promise<Record<string, unknown>>)(text, images);

    stopping = new InterruptableStoppingCriteria();
    const start = performance.now();
    let tokenCount = 0;
    const streamer = new TextStreamer(proc.tokenizer as never, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (chunk: string) => {
        tokenCount += 1;
        post({ type: 'token', text: chunk });
      },
    });

    log('info', 'generate: starting');
    await (model as { generate: (a: Record<string, unknown>) => Promise<unknown> }).generate({
      ...inputs,
      max_new_tokens: req.maxNewTokens,
      do_sample: false,
      repetition_penalty: 1.2,
      no_repeat_ngram_size: 3,
      stopping_criteria: stopping,
      streamer,
    });

    const elapsedMs = performance.now() - start;
    const interrupted = stopping.interrupted;
    stopping = null;
    log(
      'info',
      `generate: ${interrupted ? 'stopped' : 'done'} · ${tokenCount} tokens · ${(elapsedMs / 1000).toFixed(1)}s`,
    );
    post({ type: 'generated', tokens: tokenCount, elapsedMs, interrupted });
  } catch (err) {
    stopping = null;
    const message = err instanceof Error ? err.message : String(err);
    log('error', `generate failed: ${message}`);
    post({ type: 'generateError', message, isWebGpu: isWebGpuError(err) });
  }
}

self.addEventListener('message', (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'load':
      void handleLoad(msg);
      break;
    case 'generate':
      void handleGenerate(msg);
      break;
    case 'interrupt':
      if (stopping) {
        stopping.interrupt();
        log('warn', 'generate: interrupt requested');
      }
      break;
  }
});

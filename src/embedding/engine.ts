import { join } from "node:path";
import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { errorMessage } from "../utils/context.js";
import { DATA_DIR } from "../constants.js";

const MODEL_ID = "jinaai/jina-embeddings-v2-base-code";
const DIMENSIONS = 768;
const EMBED_BATCH_SIZE = 32;
// count x longest^2 bound: 32 x 1,000-char minified chunks peaked 1.8 GB over the model; this halves it.
const EMBED_BATCH_CHARS_SQ = 16_000_000;

// The default cache lives in the versioned package dir and is lost on every upgrade.
env.cacheDir = join(DATA_DIR, "models");

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

async function loadExtractor(): Promise<FeatureExtractionPipeline> {
  console.error(`[dfine-semantic] Loading model ${MODEL_ID}...`);
  const ext = await pipeline("feature-extraction", MODEL_ID, { dtype: "fp32" });
  console.error("[dfine-semantic] Model loaded");
  return ext;
}

function getExtractor(): Promise<FeatureExtractionPipeline> {
  // Forget a failed load, so the next call retries instead of failing until a restart.
  extractorPromise ??= loadExtractor().catch((error: unknown) => {
    extractorPromise = null;
    console.error(`[dfine-semantic] Model load failed: ${errorMessage(error)}`);
    throw error;
  });
  return extractorPromise;
}

// One input with its vector, as the stores write them.
export interface Embedded<T> {
  readonly item: T;
  readonly embedding: Float32Array;
}

// Lengths ascend, so the newest member is always the longest one in the batch.
function batchEnd(lengths: readonly number[], start: number): number {
  let end = start + 1;
  while (end < lengths.length && end - start < EMBED_BATCH_SIZE) {
    const longest = lengths[end] ?? 0;
    if ((end - start + 1) * longest * longest > EMBED_BATCH_CHARS_SQ) break;
    end++;
  }
  return end;
}

// Length-sorted batches pad less; vectors come back in input order.
export async function embedTexts(
  texts: readonly string[],
  signal?: AbortSignal
): Promise<Float32Array[]> {
  // Nothing to embed must not load, or first download, the model.
  if (texts.length === 0) return [];
  const ext = await getExtractor();
  const order = texts
    .map((text, index) => ({ text, index }))
    .sort((a, b) => a.text.length - b.text.length);
  const lengths = order.map((item) => item.text.length);
  const out = new Array<Float32Array>(texts.length);
  for (let start = 0; start < order.length;) {
    signal?.throwIfAborted();
    const end = batchEnd(lengths, start);
    const batch = order.slice(start, end);
    const output = await ext(
      batch.map((item) => item.text),
      { pooling: "mean", normalize: true }
    );
    // Tensor.data is typed for every dtype; this fp32 pipeline only ever returns a Float32Array.
    const flat = output.data as Float32Array;
    // slice() copies, so no stored vector keeps the whole batch tensor alive.
    batch.forEach((item, j) => {
      out[item.index] = flat.slice(j * DIMENSIONS, (j + 1) * DIMENSIONS);
    });
    // ONNX tensors hold native memory until disposed.
    output.dispose();
    start = end;
  }
  return out;
}

export async function embed(text: string): Promise<Float32Array> {
  const [vector] = await embedTexts([text]);
  if (!vector) throw new Error("The model returned no vector");
  return vector;
}

export { DIMENSIONS };

import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

const MODEL_ID = "jinaai/jina-embeddings-v2-base-code";
const DIMENSIONS = 768;
const EMBED_BATCH_SIZE = 32;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= (async () => {
    console.error(`[dfine-semantic] Loading model ${MODEL_ID}...`);
    // HuggingFace pipeline() has too many overloads for TS to resolve
    const p = pipeline as (
      task: string,
      model: string,
      options: { dtype: string }
    ) => Promise<FeatureExtractionPipeline>;
    const ext = await p("feature-extraction", MODEL_ID, { dtype: "fp32" });
    console.error("[dfine-semantic] Model loaded");
    return ext;
  })();
  return extractorPromise;
}

export async function embed(text: string): Promise<Float32Array> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: "mean", normalize: true });
  const data = new Float32Array(output.data as Float32Array);
  // CRITICAL: Dispose ONNX tensor to prevent memory leak
  if (typeof output.dispose === "function") output.dispose();
  return data;
}

// Batched embedding for indexing — far faster than one call per chunk.
// Sub-batched to cap peak memory regardless of how many chunks a file has.
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const ext = await getExtractor();
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const slice = texts.slice(i, i + EMBED_BATCH_SIZE);
    const output = await ext(slice, { pooling: "mean", normalize: true });
    const flat = output.data as Float32Array;
    for (let j = 0; j < slice.length; j++) {
      out.push(
        new Float32Array(flat.slice(j * DIMENSIONS, (j + 1) * DIMENSIONS))
      );
    }
    if (typeof output.dispose === "function") output.dispose();
  }
  return out;
}

export { DIMENSIONS };

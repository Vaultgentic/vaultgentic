import type { pipeline as transformersPipeline } from "@huggingface/transformers";
import { VaultgenticError } from "./errors.js";

export type EmbeddingModelMetadata = {
  modelId: string;
  dimension: number;
  normalized: boolean;
};

export type EmbeddingResult = {
  vector: number[];
  metadata: EmbeddingModelMetadata;
};

type FeatureExtractionPipeline = Awaited<
  ReturnType<typeof transformersPipeline<"feature-extraction">>
>;

type EmbeddingTensor = {
  data: ArrayLike<number>;
  dims: number[];
};

export const embeddingModelMetadata: EmbeddingModelMetadata = {
  modelId: "Xenova/all-MiniLM-L6-v2",
  dimension: 384,
  normalized: true,
};

let loadingPipeline: Promise<FeatureExtractionPipeline> | undefined;

export class EmbeddingServiceError extends VaultgenticError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingServiceError";
  }
}

export const embedText = async (text: string): Promise<EmbeddingResult> => {
  const extractor = await loadEmbeddingPipeline();

  try {
    const output = (await extractor(text, {
      pooling: "mean",
      normalize: embeddingModelMetadata.normalized,
    })) as EmbeddingTensor;
    const vector = Array.from(output.data);

    if (
      output.dims.length !== 2 ||
      output.dims[0] !== 1 ||
      output.dims[1] !== embeddingModelMetadata.dimension ||
      vector.length !== embeddingModelMetadata.dimension
    ) {
      throw new EmbeddingServiceError(
        `Embedding model returned shape [${output.dims.join(", ")}] with ${vector.length} values; expected [1, ${embeddingModelMetadata.dimension}]`,
      );
    }

    return {
      vector,
      metadata: embeddingModelMetadata,
    };
  } catch (error) {
    if (error instanceof EmbeddingServiceError) {
      throw error;
    }

    throw new EmbeddingServiceError(
      `Failed to generate embedding with model ${embeddingModelMetadata.modelId}`,
      { cause: error },
    );
  }
};

export const embedQueryText = async (query: string): Promise<EmbeddingResult> =>
  embedText(query);

export const embedChunkText = async (
  chunkText: string,
): Promise<EmbeddingResult> => embedText(chunkText);

const loadEmbeddingPipeline = async (): Promise<FeatureExtractionPipeline> => {
  loadingPipeline ??= createEmbeddingPipeline().catch((error: unknown) => {
    loadingPipeline = undefined;
    throw new EmbeddingServiceError(
      `Failed to load embedding model ${embeddingModelMetadata.modelId}`,
      { cause: error },
    );
  });

  return loadingPipeline;
};

const createEmbeddingPipeline =
  async (): Promise<FeatureExtractionPipeline> => {
    const { pipeline } = await import("@huggingface/transformers");

    return pipeline("feature-extraction", embeddingModelMetadata.modelId);
  };

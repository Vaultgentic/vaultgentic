import { beforeEach, describe, expect, it, vi } from "vitest";

const pipelineMock = vi.fn();

vi.mock("@huggingface/transformers", () => ({
  pipeline: pipelineMock,
}));

describe("GIVEN the local embedding service", () => {
  beforeEach(() => {
    vi.resetModules();
    pipelineMock.mockReset();
  });

  describe("WHEN text is embedded", () => {
    describe("THEN the configured model produces normalized vectors", () => {
      it("SHOULD expose metadata and return a 384 dimension vector", async () => {
        const extractor = vi.fn().mockResolvedValue({
          data: new Float32Array(384).fill(0.25),
          dims: [1, 384],
        });
        pipelineMock.mockResolvedValue(extractor);
        const { embedText, embeddingModelMetadata } = await import(
          "./embedding.js"
        );

        const result = await embedText("search this note");

        expect(pipelineMock).toHaveBeenCalledWith(
          "feature-extraction",
          "Xenova/all-MiniLM-L6-v2",
        );
        expect(extractor).toHaveBeenCalledWith("search this note", {
          pooling: "mean",
          normalize: true,
        });
        expect(result.metadata).toEqual(embeddingModelMetadata);
        expect(result.vector).toHaveLength(384);
      });

      it("SHOULD NOT reload the model for repeated embeddings", async () => {
        const extractor = vi.fn().mockResolvedValue({
          data: new Float32Array(384),
          dims: [1, 384],
        });
        pipelineMock.mockResolvedValue(extractor);
        const { embedText } = await import("./embedding.js");

        await embedText("first");
        await embedText("second");

        expect(pipelineMock).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("WHEN query and chunk text are embedded", () => {
    describe("THEN both use the same feature extraction path", () => {
      it("SHOULD call the extractor with the same options", async () => {
        const extractor = vi.fn().mockResolvedValue({
          data: new Float32Array(384),
          dims: [1, 384],
        });
        pipelineMock.mockResolvedValue(extractor);
        const { embedChunkText, embedQueryText } = await import(
          "./embedding.js"
        );

        await embedQueryText("query text");
        await embedChunkText("chunk text");

        expect(extractor).toHaveBeenNthCalledWith(1, "query text", {
          pooling: "mean",
          normalize: true,
        });
        expect(extractor).toHaveBeenNthCalledWith(2, "chunk text", {
          pooling: "mean",
          normalize: true,
        });
      });
    });
  });

  describe("WHEN the model cannot be loaded", () => {
    describe("THEN a clear service error is raised", () => {
      it("SHOULD include the model id and original cause", async () => {
        const cause = new Error("offline");
        pipelineMock.mockRejectedValue(cause);
        const { embedText } = await import("./embedding.js");

        await expect(embedText("hello")).rejects.toMatchObject({
          name: "EmbeddingServiceError",
          message: "Failed to load embedding model Xenova/all-MiniLM-L6-v2",
          cause,
        });
      });
    });
  });

  describe("WHEN inference fails", () => {
    describe("THEN a clear service error is raised", () => {
      it("SHOULD include the model id and original cause", async () => {
        const cause = new Error("bad tensor");
        const extractor = vi.fn().mockRejectedValue(cause);
        pipelineMock.mockResolvedValue(extractor);
        const { embedText } = await import("./embedding.js");

        await expect(embedText("hello")).rejects.toMatchObject({
          name: "EmbeddingServiceError",
          message:
            "Failed to generate embedding with model Xenova/all-MiniLM-L6-v2",
          cause,
        });
      });
    });
  });
});

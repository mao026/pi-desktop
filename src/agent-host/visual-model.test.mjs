import assert from "node:assert/strict";
import test from "node:test";
import { analyzeVisualScreenshot } from "./visual-model.ts";

const input = {
  model: { provider: "qwen", modelId: "qwen-vl" },
  image: { mimeType: "image/png", data: "cG5n" },
  instruction: "检查明显视觉异常",
};

test("visual analysis uses one image-only side request and rejects non-visual models", async () => {
  let request;
  const runtime = {
    getModel(_provider, modelId) {
      return { id: modelId, provider: "qwen", input: modelId === "qwen-vl" ? ["text", "image"] : ["text"] };
    },
    async completeSimple(_model, context, options) {
      request = { context, options };
      return {
        stopReason: "stop",
        content: [{ type: "text", text: "未发现明显视觉问题" }],
      };
    },
  };

  assert.equal(await analyzeVisualScreenshot(runtime, input), "未发现明显视觉问题");
  assert.equal(request.context.tools, undefined);
  assert.equal(request.context.messages.length, 1);
  assert.deepEqual(request.context.messages[0].content[1], { type: "image", data: "cG5n", mimeType: "image/png" });
  assert.equal(request.options.cacheRetention, "none");
  assert.equal(request.options.maxRetries, 0);

  await assert.rejects(
    analyzeVisualScreenshot(runtime, { ...input, model: { provider: "qwen", modelId: "qwen-text" } }),
    /不支持图片输入/,
  );
});

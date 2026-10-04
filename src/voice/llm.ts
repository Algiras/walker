import * as ort from "onnxruntime-web/webgpu";
import { AutoTokenizer } from "@huggingface/transformers";
import { fetchCached, Progress } from "./cache";
import { PickFn } from "./decide";
import { createTev1Picker, Tokenizer } from "./tev1";

export const TEV1_REPO = "goldenfox/tev1-0.8b-decision-onnx";
const BASE = `https://huggingface.co/${TEV1_REPO}/resolve/main/`;

/** Loads Together's Tev1 0.8B decision model (about 770 MB, cached) on WebGPU. Throws if WebGPU is unavailable. */
export async function loadPicker(onProgress: Progress): Promise<PickFn> {
  if (!("gpu" in navigator)) throw new Error("WebGPU is not available in this browser");
  const [model, data, template] = await Promise.all([
    fetchCached(BASE + "model.onnx", onProgress),
    fetchCached(BASE + "model.onnx.data", onProgress),
    fetch(BASE + "chat_template.jinja").then((r) => r.text()),
  ]);
  const tokenizer = (await AutoTokenizer.from_pretrained(TEV1_REPO)) as unknown as Tokenizer;
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ["webgpu"],
    externalData: [{ path: "model.onnx.data", data }],
  });
  const pick = createTev1Picker(ort, session, tokenizer, template);
  await pick({ utterance: "warm up", context: "", options: [{ key: "a", text: "one" }, { key: "b", text: "two" }] });
  return pick;
}

import { AutoModelForCausalLM, AutoTokenizer, Tensor, env } from "@huggingface/transformers";
import { PickFn } from "./decide";

env.allowLocalModels = false;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SYSTEM = "You are the decision engine of a tower defense game. The player speaks to their hero. The speech is transcribed and may contain recognition errors. You choose exactly one option and answer with its letter only.";

export interface LlmOptions {
  model: string;
  device: "webgpu" | "wasm";
  dtype: string;
  onProgress: (file: string, got: number, total: number) => void;
}

export async function loadPicker(o: LlmOptions): Promise<PickFn> {
  const tokenizer = await AutoTokenizer.from_pretrained(o.model);
  const model = await AutoModelForCausalLM.from_pretrained(o.model, {
    device: o.device,
    dtype: o.dtype as never,
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === "progress" && p.file) o.onProgress(p.file.split("/").pop()!, p.loaded ?? 0, p.total ?? 0);
    },
  });
  const letterIds = [...LETTERS].map((l) => Number(tokenizer.encode(l, { add_special_tokens: false })[0]));
  const names: string[] = (model as unknown as { sessions: Record<string, { inputNames: string[] }> }).sessions.model?.inputNames ?? [];
  const keepOne = names.includes("num_logits_to_keep");

  const pick: PickFn = async ({ utterance, question, guide, context, options }) => {
    const body = options.map((t, i) => `${LETTERS[i]}. ${t}`).join("\n");
    const rules = guide.map((g) => `- ${g}`).join("\n");
    const user = `Game state: ${context}\n\nRules:\n${rules}\n\nPlayer said: "${utterance}"\n\n${question}\n${body}\n\nAnswer with one letter.`;
    const prompt = tokenizer.apply_chat_template(
      [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      { add_generation_prompt: true, tokenize: false },
    ) as string;
    const inputs = tokenizer(prompt, { add_special_tokens: false });
    const feed: Record<string, unknown> = { ...inputs };
    if (keepOne) feed.num_logits_to_keep = new Tensor("int64", [1n], []);
    const out = await (model as unknown as (x: unknown) => Promise<{ logits: Tensor }>)(feed);
    const last = out.logits.slice(null, -1, null).to("float32");
    const logits = last.data as Float32Array;
    const raw = options.map((_, i) => logits[letterIds[i]]);
    const max = Math.max(...raw);
    const exps = raw.map((x) => Math.exp(x - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map((x) => x / sum);
    return { index: probs.indexOf(Math.max(...probs)), probs };
  };

  await pick({ utterance: "warm up", question: "Which?", guide: [], context: "", options: ["one", "two"] });
  return pick;
}

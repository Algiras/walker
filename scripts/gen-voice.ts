// Records every line the hero can say with Kokoro (deep male voice), then bakes in the radio-style processing
// with ffmpeg and writes small MP3s to public/voice/ plus a manifest. Cached: lines that already have a file are skipped.
// Pass --force to re-record everything. Needs ffmpeg on the PATH.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { KokoroTTS } from "kokoro-js";
import { allLines } from "../src/voice/callouts";

const VOICE = "am_onyx";
const OUT = new URL("../public/voice/", import.meta.url).pathname;
const RAW = new URL("../.cache/voice-raw/", import.meta.url).pathname;
const force = process.argv.includes("--force");

const slug = (l: string) => l.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function wav(pcm: Float32Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(pcm.length * 2, 40);
  pcm.forEach((v, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2));
  return b;
}

// trim silence at both ends, drop the pitch about 8% (heavier and a touch slower), add low-end weight,
// compress lightly and keep peaks out of clipping.
const FILTER = [
  "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02",
  "areverse", "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02", "areverse",
  "asetrate=22080", "aresample=24000",
  "lowshelf=g=4:f=150", "acompressor=threshold=-20dB:ratio=3:attack=5:release=80",
  "alimiter=limit=0.89",
].join(",");

mkdirSync(OUT, { recursive: true });
mkdirSync(RAW, { recursive: true });
const lines = allLines();
const todo = lines.filter((l) => force || !existsSync(`${OUT}${slug(l)}.mp3`));
let tts: KokoroTTS | null = null;
for (const [i, line] of todo.entries()) {
  const raw = `${RAW}${VOICE}-${slug(line)}.wav`;
  if (force || !existsSync(raw)) {
    tts ??= await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp32", device: "cpu" });
    const a = await tts.generate(line, { voice: VOICE as never });
    writeFileSync(raw, wav(a.audio, a.sampling_rate));
  }
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-af", FILTER, "-ac", "1", "-ar", "24000", "-codec:a", "libmp3lame", "-b:a", "64k", `${OUT}${slug(line)}.mp3`]);
  if (i % 10 === 0) console.log(`${i + 1}/${todo.length} ${line}`);
}

const lineMap = Object.fromEntries(lines.map((l) => [l, `${slug(l)}.mp3`]));
writeFileSync(`${OUT}manifest.json`, JSON.stringify({ voice: VOICE, lines: lineMap }, null, 1) + "\n");
console.log(`${lines.length} lines (${todo.length} recorded)`);

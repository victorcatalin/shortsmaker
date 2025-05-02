import { KokoroTTS, TextSplitterStream } from "kokoro-js";
import {
  VoiceEnum,
  type kokoroModelPrecision,
  type Voices,
} from "../../types/shorts";
import { logger } from "../../config";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "fp32"; // Options: "fp32", "fp16", "q8", "q4", "q4f16"

export class Kokoro {
  constructor(private readonly tts: KokoroTTS) {}

  async generate(
    text: string,
    voice: Voices,
    chunkSize = 350,                   // characters per slice
  ): Promise<{ audio: ArrayBuffer; audioLength: number }> {

    logger.debug({ chars: text.length, voice, chunkSize }, "▶️ Kokoro.generate");

    // 1️⃣ splitter + stream
    logger.debug({ text, voice }, "Generating audio with Kokoro");
    const splitter = new TextSplitterStream();
    const stream   = this.tts.stream(splitter, { voice });

    // 2️⃣ feed text incrementally
    for (const tok of text.match(/\S+\s*/g) ?? []) splitter.push(tok);
    splitter.close();

    // 3️⃣ collect audio chunks
    const bufs: Float32Array[] = [];
    let sr = 24_000;
    let i  = 0;
    for await (const { audio } of stream) {
      bufs.push(audio.audio);
      sr = audio.sampling_rate;
      logger.debug({ chunk: ++i, samples: audio.audio.length }, "⏺️ TTS chunk");
    }

    const pcm = Float32Array.from(bufs.flatMap(b => Array.from(b)));
    const len = pcm.length / sr;
    logger.debug({ chunks: i, audioLength: len }, "✅ Kokoro finished");
    logger.debug({ text, voice }, "Audio generated with Kokoro");

    return {
      audio: float32ToWav(pcm, sr),
      audioLength: len,
    };
  }

  static async init(dtype: kokoroModelPrecision): Promise<Kokoro> {
    const tts = await KokoroTTS.from_pretrained(MODEL, {
      dtype,
      device: "cpu", // only "cpu" is supported in node
    });
    return new Kokoro(tts);
  }

  listAvailableVoices(): Voices[] {
    const voices = Object.values(VoiceEnum) as Voices[];
    return voices;
  }
}

/* helper: PCM → 16-bit WAV (mono) */
function float32ToWav(samples: Float32Array, sr: number): ArrayBuffer {
  const out = new ArrayBuffer(44 + samples.length * 2);
  const v   = new DataView(out);
  let p = 0, wS=(s:string)=>[...s].forEach(c=>v.setUint8(p++,c.charCodeAt(0)));
  const w16=(d:number)=>{v.setUint16(p,d,true);p+=2;};
  const w32=(d:number)=>{v.setUint32(p,d,true);p+=4;};
  wS("RIFF"); w32(out.byteLength-8); wS("WAVEfmt ");
  w32(16); w16(1); w16(1); w32(sr); w32(sr*2); w16(2); w16(16);
  wS("data"); w32(samples.length*2);
  samples.forEach(s=>{v.setInt16(p,Math.max(-1,Math.min(1,s))*0x7fff,true);p+=2;});
  return out;
}

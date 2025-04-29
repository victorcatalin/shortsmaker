import { KokoroTTS } from "kokoro-js";
import {
  VoiceEnum,
  type kokoroModelPrecision,
  type Voices,
} from "../../types/shorts";
import { logger } from "../../config";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

export class Kokoro {
  constructor(private tts: KokoroTTS) {}

  async generate(
    text: string,
    voice: Voices,
  ): Promise<{
    audio: ArrayBuffer;
    audioLength: number;
  }> {
    logger.debug({ text, voice }, "Generating audio with Kokoro");
    const audio = await this.tts.generate(text, {
      voice: voice,
    });
    logger.debug({ text, voice }, "Audio generated with Kokoro");

    return {
      audio: audio.toWav(),
      audioLength: audio.audio.length / audio.sampling_rate,
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

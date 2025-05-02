/* eslint-disable @remotion/deterministic-randomness */
import fs   from "fs-extra";
import path from "path";
import cuid from "cuid";

// ─── Local libraries ────────────────────────────────────────────────────────
import { Config }      from "../config";
import { Kokoro }      from "./libraries/Kokoro";
import { Remotion }    from "./libraries/Remotion";
import { Whisper }     from "./libraries/Whisper";
import { FFMpeg }      from "./libraries/FFmpeg";
import { PexelsAPI }   from "./libraries/Pexels";
import { MusicManager } from "./music";
import { logger }       from "../logger";

// ─── Types ──────────────────────────────────────────────────────────────────
import type {
  SceneInput,
  RenderConfig,
  Scene,
  VideoStatus,
  MusicMoodEnum,
  MusicTag,
  Music,
} from "../types/shorts";

// ────────────────────────────────────────────────────────────────────────────
//  Speech‑aware auto‑chunking helpers
// ────────────────────────────────────────────────────────────────────────────
const AVG_SPEECH_RATE = 13; // chars / second ― empirical average
const TARGET_SEC      = 25; // preferred maximum scene length in seconds

/**
 * Split long paragraphs into roughly‑25‑second chunks while keeping sentences intact.
 */
function autoChunk(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const out: string[] = [];
  let current = "";

  for (const s of sentences) {
    const secs = (current.length + s.length) / AVG_SPEECH_RATE;
    if (secs > TARGET_SEC && current) {
      out.push(current.trim());
      current = s;
    } else {
      current += " " + s;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
//  Core class – orchestrates the entire short‑video pipeline
// ────────────────────────────────────────────────────────────────────────────
export class ShortCreator {
  /** FIFO render queue so we never render more than one video at a time. */
  private queue: { sceneInput: SceneInput[]; config: RenderConfig; id: string }[] = [];

  constructor(
    private config: Config,
    private remotion: Remotion,
    private kokoro: Kokoro,
    private whisper: Whisper,
    private ffmpeg: FFMpeg,
    private pexelsApi: PexelsAPI,
    private musicManager: MusicManager,
  ) {}

  // ── Public helpers ────────────────────────────────────────────────────────
  public status(id: string): VideoStatus {
    if (this.queue.find((q) => q.id === id)) return "processing";
    return fs.existsSync(this.getVideoPath(id)) ? "ready" : "failed";
  }

  public addToQueue(sceneInput: SceneInput[], config: RenderConfig): string {
    const id = cuid();
    this.queue.push({ sceneInput, config, id });
    if (this.queue.length === 1) void this.processQueue();
    return id;
  }

  public getVideoPath(id: string) { return path.join(this.config.videosDirPath, `${id}.mp4`); }
  public deleteVideo(id: string)  { fs.removeSync(this.getVideoPath(id)); }
  public getVideo(id: string) {
    const p = this.getVideoPath(id);
    if (!fs.existsSync(p)) throw new Error(`Video ${id} not found`);
    return fs.readFileSync(p);
  }

  public ListAvailableMusicTags(): MusicTag[] {
    const set = new Set<MusicTag>();
    this.musicManager.musicList().forEach((m) => set.add(m.mood as MusicTag));
    return [...set];
  }

  public ListAvailableVoices(): string[] {
    return this.kokoro.listAvailableVoices();
  }

  // ── Private – queue processor ─────────────────────────────────────────────
  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) return;
    const { sceneInput, config, id } = this.queue[0];

    logger.debug({ id, sceneCount: sceneInput.length }, "🚚 Starting video from queue");

    try {
      await this.createShort(id, sceneInput, config);
      logger.debug({ id }, "✅ Video rendered successfully");
    } catch (err) {
      logger.error({ id, err }, "❌ Error while creating video");
    } finally {
      this.queue.shift();
      void this.processQueue();
    }
  }

  // ── Private – main pipeline ───────────────────────────────────────────────
  private async createShort(
    videoId: string,
    inputScenes: SceneInput[],
    config: RenderConfig,
  ): Promise<string> {
    // 1️⃣ Expand paragraphs into ~25‑second chunks --------------------------------
    const scenesToRender: SceneInput[] = [];
    for (const s of inputScenes) {
      const needChunk = s.text.length / AVG_SPEECH_RATE > TARGET_SEC;
      if (needChunk) {
        scenesToRender.push(
          ...autoChunk(s.text).map((t) => ({ text: t, searchTerms: s.searchTerms }))
        );
      } else {
        scenesToRender.push(s);
      }
    }
    logger.debug({ original: inputScenes.length, expanded: scenesToRender.length }, "📝 Scene list prepared");

    // 2️⃣ Generate audio, captions, choose footage --------------------------------
    const scenes: Scene[] = [];
    const usedVideoIds: string[] = [];
    const tempFiles: string[] = [];

    let totalDurationSec = 0;
    for (const [idx, sc] of scenesToRender.entries()) {
      // -- TTS -------------------------------------------------------------------
      const { audio: pcmStream, audioLength } = await this.kokoro.generate(
        sc.text,
        config.voice ?? "af_heart",
      );
      let durationSec = audioLength;

      // If it's the last scene overall add tail padding -------------------------
      const isLast = idx === scenesToRender.length - 1;
      if (isLast && config.paddingBack) durationSec += config.paddingBack / 1000;

      // -- Temp file plumbing ----------------------------------------------------
      const tmpId = cuid();
      const wavPath = path.join(this.config.tempDirPath, `${tmpId}.wav`);
      const mp3Path = path.join(this.config.tempDirPath, `${tmpId}.mp3`);
      tempFiles.push(wavPath, mp3Path);

      await this.ffmpeg.saveNormalizedAudio(pcmStream, wavPath);
      await this.ffmpeg.saveToMp3(pcmStream, mp3Path);

      const captions = await this.whisper.CreateCaption(wavPath);

      // -- Stock video from Pexels ----------------------------------------------
      const videoAsset = await this.pexelsApi.findVideo(
        sc.searchTerms,
        durationSec,
        usedVideoIds,
      );
      usedVideoIds.push(videoAsset.id);

      scenes.push({
        captions,
        video: videoAsset.url,
        audio: {
          url: `http://localhost:${this.config.port}/api/tmp/${path.basename(mp3Path)}`,
          duration: durationSec,
        },
      });

      totalDurationSec += durationSec;
    }

    // 3️⃣ Select background music -------------------------------------------------
    const music = this.findMusic(totalDurationSec, config.music);

    // 4️⃣ Kick off Remotion render ----------------------------------------------
    await this.remotion.render(
      {
        music,
        scenes,
        config: {
          durationMs: totalDurationSec * 1000,
          paddingBack: config.paddingBack,
          captionBackgroundColor: config.captionBackgroundColor,
          captionPosition:        config.captionPosition,
        },
      },
      videoId,
    );

    // 5️⃣ Clean up temp artefacts -------------------------------------------------
    for (const f of tempFiles) {
      fs.removeSync(f);
    }

    logger.debug({ videoId }, "🏁 Render finished – video ready");
    return videoId;
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Helpers
  // ────────────────────────────────────────────────────────────────────────────
  private findMusic(lenSec: number, tag?: MusicMoodEnum): Music {
    const pool = this.musicManager.musicList().filter((m) => (!tag ? true : m.mood === tag));
    return pool[Math.floor(Math.random() * pool.length)];
  }
}

/* eslint-disable @remotion/deterministic-randomness */
import fs   from "fs-extra";
import path from "path";
import cuid from "cuid";

import { Config }    from "../config";
import { Kokoro }    from "./libraries/Kokoro";
import { Remotion }  from "./libraries/Remotion";
import { Whisper }   from "./libraries/Whisper";
import { FFMpeg }    from "./libraries/FFmpeg";
import { PexelsAPI } from "./libraries/Pexels";
import { MusicManager } from "./music";
import { logger } from "../logger";

import type {
  SceneInput, RenderConfig, Scene, VideoStatus,
  MusicMoodEnum, MusicTag, Music } from "../types/shorts";

// speech stats for auto-chunking
const AVG_SPEECH_RATE = 13; // chars per second
const TARGET_SEC      = 25; // preferred scene length

// sentence-aware splitter
function autoChunk(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const out: string[] = [];
  let current = "";

  for (const s of sentences) {
    const sec = (current.length + s.length) / AVG_SPEECH_RATE;
    if (sec > TARGET_SEC && current) { out.push(current.trim()); current = s; }
    else                             { current += " " + s; }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export class ShortCreator {
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

  // ── basic helpers ──────────────────────────────────────────────────────────
  public status(id: string): VideoStatus {
    if (this.queue.find(i => i.id === id)) return "processing";
    return fs.existsSync(this.getVideoPath(id)) ? "ready" : "failed";
  }

  public addToQueue(sceneInput: SceneInput[], config: RenderConfig): string {
    const id = cuid();
    this.queue.push({ sceneInput, config, id });
    if (this.queue.length === 1) void this.processQueue();
    return id;
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) return;
    const { sceneInput, config, id } = this.queue[0];
    try {
      await this.createShort(id, sceneInput, config);
      logger.debug({ id }, "Video created successfully");
    } catch (err) {
      logger.error({ err }, "Error creating video");
    } finally {
      this.queue.shift();
      void this.processQueue();
    }
  }

  // ── main pipeline ──────────────────────────────────────────────────────────
  private async createShort(
    videoId: string,
    inputScenes: SceneInput[],
    config: RenderConfig,
  ): Promise<string> {

    // 1️⃣ expand giant paragraphs into 25-s scenes
    const scenesToRender: SceneInput[] = [];
    for (const s of inputScenes) {
      const parts = (s.text.length / AVG_SPEECH_RATE > TARGET_SEC)
        ? autoChunk(s.text).map(t => ({ text: t, searchTerms: s.searchTerms }))
        : [s];
      scenesToRender.push(...parts);
    }
    logger.debug({ original: inputScenes.length, expanded: scenesToRender.length },
                 "Scene list expanded");

    // 2️⃣ process each scene
    const scenes: Scene[] = [];
    let totalDur = 0;
    const usedVideoIds: string[] = [];

    for (const [index, sc] of scenesToRender.entries()) {
      // -- TTS
      const { audio: pcm, audioLength } =
        await this.kokoro.generate(sc.text, "af_heart");

      // -- Captions
      const tmp = path.join(this.config.tempDirPath, `${cuid()}.wav`);
      await this.ffmpeg.normalizeAudioForWhisper(pcm, tmp);
      const captions = await this.whisper.CreateCaption(tmp);
      fs.removeSync(tmp);

      // -- Video
      const video = await this.pexelsApi.findVideo(
        sc.searchTerms, audioLength, usedVideoIds,
      );
      usedVideoIds.push(video.id);

      scenes.push({
        captions,
        video: video.url,
        audio: {
          dataUri: await this.ffmpeg.createMp3DataUri(pcm),
          duration: audioLength,
        },
      });
      totalDur += audioLength;
    }

    if (config.paddingBack) totalDur += config.paddingBack / 1000;

    // 3️⃣ music + render
    const music = this.findMusic(totalDur, config.music);
    await this.remotion.render(
      { music, scenes,
        config: { durationMs: totalDur * 1000, paddingBack: config.paddingBack } },
      videoId,
    );
    logger.debug({ videoId }, "🏁 render finished");
    return videoId;
  }

  // ── file helpers ───────────────────────────────────────────────────────────
  public getVideoPath(id: string) { return path.join(this.config.videosDirPath, `${id}.mp4`); }
  public deleteVideo(id: string)  { fs.removeSync(this.getVideoPath(id)); }
  public getVideo(id: string) {
    const p = this.getVideoPath(id);
    if (!fs.existsSync(p)) throw new Error(`Video ${id} not found`);
    return fs.readFileSync(p);
  }

  // ── music helpers ──────────────────────────────────────────────────────────
  private findMusic(len: number, tag?: MusicMoodEnum): Music {
    const pool = this.musicManager.musicList().filter(m => !tag || m.mood === tag);
    return pool[Math.floor(Math.random() * pool.length)];
  }
  public ListAvailableMusicTags(): MusicTag[] {
    const set = new Set<MusicTag>();
    this.musicManager.musicList().forEach(m => set.add(m.mood as MusicTag));
    return [...set];
  }
}

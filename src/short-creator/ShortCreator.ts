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

    try {
      logger.debug(
        {
          inputScenes,
        },
        "Creating short video",
      );
      const scenes: Scene[] = [];
      let totalDuration = 0;
      const excludeVideoIds = [];
      const tempFiles = [];

      for (const [index, sc] of scenesToRender.entries()) {
      // -- TTS
        const { audio: pcm, audioLength } =
        await this.kokoro.generate(sc.text,
          config.voice ?? "af_heart",);

        // -- Captions
        const tmp = path.join(this.config.tempDirPath, `${cuid()}.wav`);
      await this.ffmpeg.normalizeAudioForWhisper(pcm, tmp);
        const captions = await this.whisper.CreateCaption(tmp);
      fs.removeSync(tmp);

      const tempId = cuid();
      const tempWavFileName = `${tempId}.wav`;
      const tempMp3FileName = `${tempId}.mp3`;
      const tempWavPath = path.join(this.config.tempDirPath, tempWavFileName);
      const tempMp3Path = path.join(this.config.tempDirPath, tempMp3FileName);
      tempFiles.push(tempWavPath, tempMp3Path);

      await this.ffmpeg.saveNormalizedAudio(audioStream, tempWavPath);
      const captions = await this.whisper.CreateCaption(tempWavPath);

      await this.ffmpeg.saveToMp3(audioStream, tempMp3Path);
      const video = await this.pexelsApi.findVideo(
        scene.searchTerms,
        audioLength,
        excludeVideoIds,
      );
      excludeVideoIds.push(video.id);

        scenes.push({
          captions,
          video: video.url,
          audio: {
            url: `http://localhost:${this.config.port}/api/tmp/${tempMp3FileName}`,
            duration: audioLength,
          },
        });

        totalDuration += audioLength;
        index++;
      }
      if (config.paddingBack) {
        totalDuration += config.paddingBack / 1000;
      }

      if (config.paddingBack) totalDur += config.paddingBack / 1000;

      await this.remotion.render(
        {
          music: selectedMusic,
          scenes,
          config: {
            durationMs: totalDuration * 1000,
            paddingBack: config.paddingBack,
            ...{
              captionBackgroundColor: config.captionBackgroundColor,
              captionPosition: config.captionPosition,
            },
          },
        },
        videoId,
      );

      for (const file of tempFiles) {
        fs.removeSync(file);
      }

      return videoId;
    } catch (error) {
      logger.error({ error: error }, "Error creating short video");
      throw error;
    }
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

  public ListAvailableVoices(): string[] {
    return this.kokoro.listAvailableVoices();
  }
}

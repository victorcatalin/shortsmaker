/* eslint-disable @remotion/deterministic-randomness */
import fs from "fs-extra";
import cuid from "cuid";
import path from "path";

import { Kokoro } from "./libraries/Kokoro";
import { Remotion } from "./libraries/Remotion";
import { Whisper } from "./libraries/Whisper";
import { FFMpeg } from "./libraries/FFmpeg";
import { PexelsAPI } from "./libraries/Pexels";
import { Config } from "../config";
import { logger } from "../logger";
import { MusicManager } from "./music";
import { type Music } from "../types/shorts";
import type {
  SceneInput,
  RenderConfig,
  Scene,
  VideoStatus,
  MusicMoodEnum,
  MusicTag,
} from "../types/shorts";

export class ShortCreator {
  private queue: {
    sceneInput: SceneInput[];
    config: RenderConfig;
    id: string;
  }[] = [];
  constructor(
    private config: Config,
    private remotion: Remotion,
    private kokoro: Kokoro,
    private whisper: Whisper,
    private ffmpeg: FFMpeg,
    private pexelsApi: PexelsAPI,
    private musicManager: MusicManager,
  ) {}

  public status(id: string): VideoStatus {
    const videoPath = this.getVideoPath(id);
    if (this.queue.find((item) => item.id === id)) {
      return "processing";
    }
    if (fs.existsSync(videoPath)) {
      return "ready";
    }
    return "failed";
  }

  public addToQueue(sceneInput: SceneInput[], config: RenderConfig): string {
    // todo add mutex lock
    const id = cuid();
    this.queue.push({
      sceneInput,
      config,
      id,
    });
    if (this.queue.length === 1) {
      this.processQueue();
    }
    return id;
  }

  private async processQueue(): Promise<void> {
    // todo add a semaphore
    if (this.queue.length === 0) {
      return;
    }
    const { sceneInput, config, id } = this.queue[0];
    logger.debug(
      { sceneInput, config, id },
      "Processing video item in the queue",
    );
    try {
      await this.createShort(id, sceneInput, config);
      logger.debug({ id }, "Video created successfully");
    } catch (error) {
      logger.error({ error }, "Error creating video");
    } finally {
      this.queue.shift();
      this.processQueue();
    }
  }

  private async createShort(
    videoId: string,
    inputScenes: SceneInput[],
    config: RenderConfig,
  ): Promise<string> {
    logger.debug({ videoId, sceneCount: inputScenes.length }, "▶️ createShort");
    const scenes: Scene[] = [];
    let totalDuration = 0;
    const excludeVideoIds: string[] = [];
  
    for (let index = 0; index < inputScenes.length; index++) {
      const scene = inputScenes[index];
  
      // --- TTS --------------------------------------------------------------
      logger.debug({ index, textLen: scene.text.length }, "⌛ generating TTS");
      const { audio: audioBuf, audioLength } =
        await this.kokoro.generate(scene.text, "af_heart");
      logger.debug({ index, audioLength }, "✅ TTS ready");
  
      // --- Captions ---------------------------------------------------------
      const tmpPath = path.join(this.config.tempDirPath, `${cuid()}.wav`);
      await this.ffmpeg.normalizeAudioForWhisper(audioBuf, tmpPath);
      const captions = await this.whisper.CreateCaption(tmpPath);
      fs.removeSync(tmpPath);
      logger.debug({ index, captionWords: captions.length }, "✅ captions ready");
  
      // --- Background video -------------------------------------------------
      const searchDur =
        audioLength +
        (index + 1 === inputScenes.length && config.paddingBack
          ? config.paddingBack / 1000
          : 0);
  
      logger.debug({ index, searchDur }, "🔍 searching Pexels");
      const video = await this.pexelsApi.findVideo(
        scene.searchTerms,
        searchDur,
        excludeVideoIds,
      );
      excludeVideoIds.push(video.id);
      logger.debug({ index, videoId: video.id }, "✅ video picked");
  
      // --- Assemble scene ---------------------------------------------------
      scenes.push({
        captions,
        video: video.url,
        audio: {
          dataUri: await this.ffmpeg.createMp3DataUri(audioBuf),
          duration: searchDur,
        },
      });
      totalDuration += searchDur;
    }
  
    if (config.paddingBack) totalDuration += config.paddingBack / 1000;
  
    // --- Pick music ---------------------------------------------------------
    const selectedMusic = this.findMusic(totalDuration, config.music);
    logger.debug({ selectedMusic, totalDuration }, "🎵 music selected");
  
    // --- Render -------------------------------------------------------------
    await this.remotion.render(
      {
        music: selectedMusic,
        scenes,
        config: { durationMs: totalDuration * 1000, paddingBack: config.paddingBack },
      },
      videoId,
    );
    logger.debug({ videoId }, "🏁 render finished");
  
    return videoId;
  }
  

  public getVideoPath(videoId: string): string {
    return path.join(this.config.videosDirPath, `${videoId}.mp4`);
  }

  public deleteVideo(videoId: string): void {
    const videoPath = this.getVideoPath(videoId);
    fs.removeSync(videoPath);
    logger.debug({ videoId }, "Deleted video file");
  }

  public getVideo(videoId: string): Buffer {
    const videoPath = this.getVideoPath(videoId);
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video ${videoId} not found`);
    }
    return fs.readFileSync(videoPath);
  }

  private findMusic(videoDuration: number, tag?: MusicMoodEnum): Music {
    const musicFiles = this.musicManager.musicList().filter((music) => {
      if (tag) {
        return music.mood === tag;
      }
      return true;
    });
    return musicFiles[Math.floor(Math.random() * musicFiles.length)];
  }

  public ListAvailableMusicTags(): MusicTag[] {
    const tags = new Set<MusicTag>();
    this.musicManager.musicList().forEach((music) => {
      tags.add(music.mood as MusicTag);
    });
    return Array.from(tags.values());
  }
}

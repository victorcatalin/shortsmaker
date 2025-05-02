import { CalculateMetadataFunction, Composition } from "remotion";
import { ShortVideo, shortVideoSchema } from "../videos/ShortVideo";
import z from "zod";

const FPS = 25;

export const calculateMetadata: CalculateMetadataFunction<
  z.infer<typeof shortVideoSchema>
> = async ({ props }) => {
  const durationInFrames = Math.floor((props.config.durationMs / 1000) * FPS);
  return {
    ...props,
    durationInFrames,
  };
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ShortVideo"
        component={ShortVideo}
        durationInFrames={30}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{
          music: {
            file: "mellow-smooth-rap-beat-20230107-132480.mp3",
            start: 0,
            end: 175,
          },
          scenes: [
            {
              captions: [
                { text: " Hello", startMs: 390, endMs: 990 },
                { text: " World.", startMs: 990, endMs: 2000 },
              ],
              video:
                "https://videos.pexels.com/video-files/4625747/4625747-hd_1080_1920_24fps.mp4",
              audio: {
                url: "http://localhost:3123/api/tmp/cma1lgean0001rlsi52b8h3n3.mp3",
                duration: 3.15,
              },
            },
          ],
          config: {
            durationMs: 4650,
            paddingBack: 1500,
            captionBackgroundColor: "blue",
            captionPosition: "bottom",
          },
        }}
        calculateMetadata={calculateMetadata}
      />
    </>
  );
};

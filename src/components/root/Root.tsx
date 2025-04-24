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
            file: "",
            start: 0,
            end: 0,
          },
          scenes: [],
          config: {
            durationMs: 0,
            paddingBack: 0,
          },
        }}
        calculateMetadata={calculateMetadata}
      />
    </>
  );
};

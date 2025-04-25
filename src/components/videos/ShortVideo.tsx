import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  Audio,
  staticFile,
  OffthreadVideo,
} from "remotion";
import { z } from "zod";
import { loadFont } from "@remotion/google-fonts/BarlowCondensed";
import type { Caption, CaptionLine, CaptionPage } from "../../types/shorts";

const { fontFamily } = loadFont(); // "Barlow Condensed"

export const shortVideoSchema = z.object({
  scenes: z.array(
    z.object({
      captions: z.custom<Caption[]>(),
      audio: z.object({
        url: z.string(),
        duration: z.number(),
      }),
      video: z.string(),
    }),
  ),
  config: z.object({
    paddingBack: z.number().optional(),
    durationMs: z.number(),
  }),
  music: z.object({
    file: z.string(),
    start: z.number(),
    end: z.number(),
  }),
});

function createCaptionPages({
  captions,
  lineMaxLength,
  lineCount,
  maxDistanceMs,
}: {
  captions: Caption[];
  lineMaxLength: number;
  lineCount: number;
  maxDistanceMs: number;
}) {
  const pages = [];
  let currentPage: CaptionPage = {
    startMs: 0,
    endMs: 0,
    lines: [],
  };
  let currentLine: CaptionLine = {
    texts: [],
  };

  captions.forEach((caption, i) => {
    // Check if we need to start a new page due to time gap
    if (i > 0 && caption.startMs - currentPage.endMs > maxDistanceMs) {
      // Add current line if not empty
      if (currentLine.texts.length > 0) {
        currentPage.lines.push(currentLine);
      }
      // Add current page if not empty
      if (currentPage.lines.length > 0) {
        pages.push(currentPage);
      }
      // Start new page
      currentPage = {
        startMs: caption.startMs,
        endMs: caption.endMs,
        lines: [],
      };
      currentLine = {
        texts: [],
      };
    }

    // Check if adding this caption exceeds the line length
    const currentLineText = currentLine.texts.map((t) => t.text).join(" ");
    if (
      currentLine.texts.length > 0 &&
      currentLineText.length + 1 + caption.text.length > lineMaxLength
    ) {
      // Line is full, add it to current page
      currentPage.lines.push(currentLine);
      currentLine = {
        texts: [],
      };

      // Check if page is full
      if (currentPage.lines.length >= lineCount) {
        // Page is full, add it to pages
        pages.push(currentPage);
        // Start new page
        currentPage = {
          startMs: caption.startMs,
          endMs: caption.endMs,
          lines: [],
        };
      }
    }

    // Add caption to current line
    currentLine.texts.push({
      text: caption.text,
      startMs: caption.startMs,
      endMs: caption.endMs,
    });

    // Update page timing
    currentPage.endMs = caption.endMs;
    if (i === 0 || currentPage.startMs === 0) {
      currentPage.startMs = caption.startMs;
    } else {
      currentPage.startMs = Math.min(currentPage.startMs, caption.startMs);
    }
  });

  // Don't forget to add the last line and page
  if (currentLine.texts.length > 0) {
    currentPage.lines.push(currentLine);
  }
  if (currentPage.lines.length > 0) {
    pages.push(currentPage);
  }

  return pages;
}

export const ShortVideo: React.FC<z.infer<typeof shortVideoSchema>> = ({
  scenes,
  music,
  config,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const activeStyle = {
    backgroundColor: "blue",
    padding: "10px",
    marginLeft: "-10px",
    marginRight: "-10px",
    borderRadius: "10px",
  };
  return (
    <AbsoluteFill style={{ backgroundColor: "white" }}>
      <Audio
        loop
        src={staticFile(music.file)}
        startFrom={music.start * fps}
        endAt={music.end * fps}
        volume={0.1}
      />

      {scenes.map((scene, i) => {
        const { captions, audio, video } = scene;
        const pages = createCaptionPages({
          captions,
          lineMaxLength: 20,
          lineCount: 1,
          maxDistanceMs: 1000,
        });

        // Calculate the start and end time of the scene
        const startFrame =
          scenes.slice(0, i).reduce((acc, curr) => {
            return acc + curr.audio.duration;
          }, 0) * fps;
        let durationInFrames =
          scenes.slice(0, i + 1).reduce((acc, curr) => {
            return acc + curr.audio.duration;
          }, 0) * fps;
        if (config.paddingBack && i === scenes.length - 1) {
          durationInFrames += (config.paddingBack / 1000) * fps;
        }

        return (
          <Sequence
            from={startFrame}
            durationInFrames={durationInFrames}
            key={`scene-${i}`}
          >
            <OffthreadVideo src={video} muted />
            <Audio src={audio.url} />
            {pages.map((page, j) => {
              return (
                <Sequence
                  key={`scene-${i}-page-${j}`}
                  from={Math.round((page.startMs / 1000) * fps)}
                  durationInFrames={Math.round(
                    ((page.endMs - page.startMs) / 1000) * fps,
                  )}
                >
                  <div
                    style={{
                      position: "absolute",
                      bottom: 100,
                      left: 10,
                      width: "100%",
                    }}
                  >
                    {page.lines.map((line, k) => {
                      return (
                        <p
                          style={{
                            fontSize: "6em",
                            fontFamily: fontFamily,
                            fontWeight: "black",
                            color: "white",
                            WebkitTextStroke: "2px black",
                            WebkitTextFillColor: "white",
                            textShadow: "0px 0px 10px black",
                            textAlign: "center",
                            width: "100%",
                            // uppercase
                            textTransform: "uppercase",
                          }}
                          key={`scene-${i}-page-${j}-line-${k}`}
                        >
                          {line.texts.map((text, l) => {
                            const active =
                              frame >=
                                startFrame + (text.startMs / 1000) * fps &&
                              frame <= startFrame + (text.endMs / 1000) * fps;
                            return (
                              <>
                                <span
                                  style={{
                                    fontWeight: "bold",
                                    ...(active ? activeStyle : {}),
                                  }}
                                  key={`scene-${i}-page-${j}-line-${k}-text-${l}`}
                                >
                                  {text.text}
                                </span>
                                {l < line.texts.length - 1 ? " " : ""}
                              </>
                            );
                          })}
                        </p>
                      );
                    })}
                  </div>
                </Sequence>
              );
            })}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

import type { CSSProperties } from "react";
import type { CharacterState, LiveMessage } from "./types";
import { colorForMessage } from "./messageColors";

const hoshiaCharacterUrl = new URL("./assets/hoshia-character-cutout.png", import.meta.url).href;

type StagePresentation = {
  label: string;
  expression: string;
  motion: string;
  cue: string;
};

const stagePresentation: Record<CharacterState, StagePresentation> = {
  IDLE: {
    label: "Waiting",
    expression: "idle_smile",
    motion: "idle_loop",
    cue: "Waiting for messages"
  },
  LISTENING: {
    label: "Reading",
    expression: "listening",
    motion: "listen_start",
    cue: "Reading incoming chat"
  },
  THINKING: {
    label: "Thinking",
    expression: "thinking",
    motion: "think_loop",
    cue: "Head tilt, brief pause"
  },
  SPEAKING: {
    label: "Speaking",
    expression: "speaking",
    motion: "speak_loop",
    cue: "Replying"
  },
  ERROR: {
    label: "Error",
    expression: "error",
    motion: "error_recover",
    cue: "Connection issue"
  }
};

const animatedLabels: Record<CharacterState, string> = {
  IDLE: "Waiting...",
  LISTENING: "Reading...",
  THINKING: "Thinking...",
  SPEAKING: "Speaking...",
  ERROR: "Error..."
};

export function getStagePresentation(state: CharacterState) {
  return stagePresentation[state];
}

export function getAnimatedStageLabel(state: CharacterState) {
  return animatedLabels[state];
}

export function CharacterStage({
  state,
  messages
}: {
  state: CharacterState;
  messages: LiveMessage[];
}) {
  const presentation = getStagePresentation(state);

  return (
    <section className={`character-stage state-${state.toLowerCase()}`} aria-label="Hoshia Live2D stage">
      <div className="stage-sky" aria-hidden="true">
        <span className="cloud cloud-a" />
        <span className="cloud cloud-b" />
        <span className="star star-a" />
        <span className="star star-b" />
        <span className="paw-mark paw-a" />
        <span className="paw-mark paw-b" />
      </div>
      <StageDanmaku messages={messages.slice(-5)} />
      <Live2DAdapter state={state} expression={presentation.expression} motion={presentation.motion} />
    </section>
  );
}

function StageDanmaku({ messages }: { messages: LiveMessage[] }) {
  return (
    <div className="stage-danmaku" aria-label="Floating danmaku behind character">
      {messages.map((message, index) => (
        <span
          key={`stage-${message.id}-${index}`}
          className={`stage-danmaku-line ${message.role}`}
          style={{
            "--danmaku-color": message.color || colorForMessage(message),
            "--lane-top": `${118 + (index % 5) * 42}px`,
            "--duration": `${11 + (index % 3) * 2}s`,
            "--delay": `${index * -1.7}s`
          } as CSSProperties}
        >
          {message.text}
        </span>
      ))}
    </div>
  );
}

function Live2DAdapter({
  state,
  expression,
  motion
}: {
  state: CharacterState;
  expression: string;
  motion: string;
}) {
  return (
    <div className="live2d-adapter" data-expression={expression} data-motion={motion}>
      <img
        className="hoshia-character"
        src={hoshiaCharacterUrl}
        alt="Hoshia temporary animated character layer"
        draggable={false}
      />
    </div>
  );
}

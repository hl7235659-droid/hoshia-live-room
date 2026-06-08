import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { CharacterState, LiveMessage } from "./types";
import { colorForMessage } from "./messageColors";

const publicBase = import.meta.env.BASE_URL || "/";
const appBase = publicBase.endsWith("/") ? publicBase : `${publicBase}/`;
const hoshiaCharacterUrl = `${appBase}assets/hoshia-character-cutout.png`;
const live2dModelUrl = import.meta.env.VITE_LIVE2D_MODEL_URL?.trim() || "";
const live2dCoreUrl = import.meta.env.VITE_LIVE2D_CORE_URL?.trim() || `${appBase}live2d/runtime/live2dcubismcore.min.js`;
const stageDanmakuLaneCount = 5;
const defaultDanmakuSpeed = 90;
const defaultStageDanmakuWidth = 430;
const danmakuExitPadding = 80;

type StagePresentation = {
  label: string;
  expression: string;
  motion: string;
  cue: string;
};

type Live2DRuntimeState = "fallback" | "loading" | "ready" | "error";

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
      <Live2DAdapter
        state={state}
        expression={presentation.expression}
        motion={presentation.motion}
        modelUrl={live2dModelUrl}
        coreUrl={live2dCoreUrl}
      />
    </section>
  );
}

function StageDanmaku({ messages }: { messages: LiveMessage[] }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(defaultStageDanmakuWidth);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const updateStageWidth = () => {
      const nextWidth = Math.round(stage.getBoundingClientRect().width);
      if (nextWidth > 0) setStageWidth(nextWidth);
    };

    updateStageWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateStageWidth);
      return () => window.removeEventListener("resize", updateStageWidth);
    }

    const observer = new ResizeObserver(updateStageWidth);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={stageRef}
      className="stage-danmaku"
      aria-label="Floating danmaku behind character"
      style={{ "--stage-width": `${stageWidth}px` } as CSSProperties}
    >
      {messages.map((message, index) => {
        const lane = stableDanmakuLane(message);
        const speed = validDanmakuSpeed(message.danmaku_speed) || defaultDanmakuSpeed;
        const duration = (stageWidth + danmakuExitPadding) / speed;
        return (
          <span
            key={`stage-${message.id}-${index}`}
            className={`stage-danmaku-line ${message.role}`}
            style={{
              "--danmaku-color": message.color || colorForMessage(message),
              "--lane-top": `${118 + lane * 42}px`,
              "--duration": `${duration}s`,
              "--delay": `${index * -1.4}s`
            } as CSSProperties}
          >
            {message.text}
          </span>
        );
      })}
    </div>
  );
}

function stableDanmakuLane(message: LiveMessage) {
  if (Number.isInteger(message.danmaku_lane)) {
    return Math.max(0, Math.min(stageDanmakuLaneCount - 1, Number(message.danmaku_lane)));
  }
  return stableHash(message.id || message.text) % stageDanmakuLaneCount;
}

function validDanmakuSpeed(speed: unknown) {
  const value = Number(speed);
  return Number.isFinite(value) && value >= 40 && value <= 180 ? value : null;
}

function stableHash(value: string) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

function Live2DAdapter({
  state,
  expression,
  motion,
  modelUrl,
  coreUrl
}: {
  state: CharacterState;
  expression: string;
  motion: string;
  modelUrl?: string;
  coreUrl: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const live2dRef = useRef<Live2DRuntimeHandle | null>(null);
  const normalizedModelUrl = modelUrl?.trim() || "";
  const [runtimeState, setRuntimeState] = useState<Live2DRuntimeState>(
    normalizedModelUrl ? "loading" : "fallback"
  );

  useEffect(() => {
    if (!normalizedModelUrl || !hostRef.current) {
      setRuntimeState("fallback");
      live2dRef.current?.destroy();
      live2dRef.current = null;
      return;
    }

    let disposed = false;
    setRuntimeState("loading");

    loadLive2DModel({
      host: hostRef.current,
      modelUrl: normalizedModelUrl,
      coreUrl,
      onReady: (handle) => {
        if (disposed) {
          handle.destroy();
          return;
        }
        live2dRef.current = handle;
        setRuntimeState("ready");
        void handle.applyPresentation(expression, motion);
      }
    }).catch(() => {
      if (!disposed) {
        live2dRef.current = null;
        setRuntimeState("error");
      }
    });

    return () => {
      disposed = true;
      live2dRef.current?.destroy();
      live2dRef.current = null;
    };
  }, [coreUrl, normalizedModelUrl]);

  useEffect(() => {
    if (runtimeState !== "ready") return;
    void live2dRef.current?.applyPresentation(expression, motion);
  }, [expression, motion, runtimeState, state]);

  return (
    <div
      className="live2d-adapter"
      data-state={state.toLowerCase()}
      data-expression={expression}
      data-motion={motion}
      data-runtime={runtimeState}
      aria-busy={runtimeState === "loading"}
    >
      <div className="live2d-canvas-host" ref={hostRef} aria-hidden={runtimeState !== "ready"} />
      <PngFallbackLayer state={state} runtimeState={runtimeState} />
    </div>
  );
}

function PngFallbackLayer({
  state,
  runtimeState
}: {
  state: CharacterState;
  runtimeState: Live2DRuntimeState;
}) {
  const isHidden = runtimeState === "ready";

  return (
    <div className={`png-fallback-layer ${isHidden ? "hidden" : ""}`} data-fallback-state={state.toLowerCase()}>
      <span className="fallback-motion-ring" aria-hidden="true" />
      <img
        className="hoshia-character live2d-fallback"
        src={hoshiaCharacterUrl}
        alt="Hoshia temporary animated character layer"
        draggable={false}
      />
      <span className="fallback-ground-shadow" aria-hidden="true" />
    </div>
  );
}

type Live2DRuntimeHandle = {
  applyPresentation: (expression: string, motion: string) => Promise<void>;
  destroy: () => void;
};

async function loadLive2DModel({
  host,
  modelUrl,
  coreUrl,
  onReady
}: {
  host: HTMLDivElement;
  modelUrl: string;
  coreUrl: string;
  onReady: (handle: Live2DRuntimeHandle) => void;
}) {
  if (!host.clientWidth || !host.clientHeight) {
    throw new Error("Live2D host has no renderable size.");
  }

  await ensureScript(coreUrl);

  const PIXI = await import("pixi.js");
  (window as Window & { PIXI?: typeof PIXI }).PIXI = PIXI;
  const { Live2DModel } = await import("pixi-live2d-display/cubism4");

  const app = new PIXI.Application({
    autoDensity: true,
    backgroundAlpha: 0,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    resizeTo: host
  });

  host.replaceChildren(app.view as HTMLCanvasElement);

  const model = await Live2DModel.from(modelUrl, { autoInteract: false });
  model.anchor.set(0.5, 1);
  app.stage.addChild(model);

  const fitModel = () => {
    const width = host.clientWidth || 430;
    const height = host.clientHeight || 640;
    app.renderer.resize(width, height);
    model.scale.set(1);
    const scale = Math.min(width / Math.max(model.width, 1), height / Math.max(model.height, 1)) * 0.92;
    model.scale.set(scale);
    model.position.set(width / 2, height * 0.98);
  };

  fitModel();
  const resizeObserver = new ResizeObserver(fitModel);
  resizeObserver.observe(host);

  onReady({
    applyPresentation: async (nextExpression, nextMotion) => {
      await Promise.allSettled([model.expression(nextExpression), model.motion(nextMotion)]);
    },
    destroy: () => {
      resizeObserver.disconnect();
      app.destroy(true, { children: true, texture: true, baseTexture: true });
      host.replaceChildren();
    }
  });
}

function ensureScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const hasCubismCore = () => Boolean((window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore);
    const existing = document.querySelector<HTMLScriptElement>(`script[data-live2d-core="${src}"]`);
    if (existing?.dataset.loaded === "true") {
      if (hasCubismCore()) resolve();
      else reject(new Error(`Cubism Core global missing after loading ${src}`));
      return;
    }
    if (existing) {
      existing.addEventListener("load", () => {
        if (hasCubismCore()) resolve();
        else reject(new Error(`Cubism Core global missing after loading ${src}`));
      }, { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.live2dCore = src;
    script.addEventListener("load", () => {
      if (hasCubismCore()) {
        script.dataset.loaded = "true";
        resolve();
      } else {
        reject(new Error(`Cubism Core global missing after loading ${src}`));
      }
    }, { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
    document.head.appendChild(script);
  });
}

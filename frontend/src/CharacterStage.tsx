import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { CharacterState, HoshiaPresentation, HoshiaVisualState, LiveMessage } from "./types";
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
const danmakuVisualSpeedScale = 0.8;

type StagePresentation = {
  label: string;
  expression: string;
  motion: string;
  cue: string;
};

type Live2DRuntimeState = "fallback" | "loading" | "ready" | "error";

const stagePresentation: Record<CharacterState, StagePresentation> = {
  IDLE: {
    label: "待接入",
    expression: "idle_smile",
    motion: "idle_loop",
    cue: "等待留言"
  },
  LISTENING: {
    label: "接收中",
    expression: "listening",
    motion: "listen_start",
    cue: "正在接收留言"
  },
  THINKING: {
    label: "整理中",
    expression: "thinking",
    motion: "think_loop",
    cue: "稍作整理"
  },
  SPEAKING: {
    label: "回应中",
    expression: "speaking",
    motion: "speak_loop",
    cue: "正在回应"
  },
  ERROR: {
    label: "异常",
    expression: "error",
    motion: "error_recover",
    cue: "联系状态异常"
  }
};

const animatedLabels: Record<CharacterState, string> = {
  IDLE: "待接入...",
  LISTENING: "接收中...",
  THINKING: "整理中...",
  SPEAKING: "回应中...",
  ERROR: "异常..."
};

const presentationDefaults: Record<HoshiaPresentation["action"], StagePresentation> = {
  idle: stagePresentation.IDLE,
  listen: stagePresentation.LISTENING,
  think: stagePresentation.THINKING,
  speak: stagePresentation.SPEAKING,
  react_positive: {
    label: stagePresentation.SPEAKING.label,
    expression: "happy",
    motion: "react_positive",
    cue: stagePresentation.SPEAKING.cue
  },
  react_negative: {
    label: stagePresentation.SPEAKING.label,
    expression: "concerned",
    motion: "react_negative",
    cue: stagePresentation.SPEAKING.cue
  },
  react_surprised: {
    label: stagePresentation.SPEAKING.label,
    expression: "surprised",
    motion: "react_surprised",
    cue: stagePresentation.SPEAKING.cue
  },
  recover: stagePresentation.ERROR
};

export function getStagePresentation(state: CharacterState) {
  return stagePresentation[state];
}

export function getAnimatedStageLabel(state: CharacterState) {
  return animatedLabels[state];
}

export function CharacterStage({
  state,
  messages,
  visualState,
  presentation
}: {
  state: CharacterState;
  messages: LiveMessage[];
  visualState: HoshiaVisualState | null;
  presentation: HoshiaPresentation | null;
}) {
  const stagePresentation = getResolvedPresentation(state, presentation);
  const pngUrl = presentation?.fallback_png || presentation?.current_png || visualState?.current_png || "";

  return (
    <section className={`character-stage state-${state.toLowerCase()}`} aria-label="星见终端角色台">
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
        action={presentation?.action || ""}
        expression={stagePresentation.expression}
        motion={stagePresentation.motion}
        pngUrl={pngUrl}
        modelUrl={live2dModelUrl}
        coreUrl={live2dCoreUrl}
      />
    </section>
  );
}

function StageDanmaku({ messages }: { messages: LiveMessage[] }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(defaultStageDanmakuWidth);
  const [messageWidths, setMessageWidths] = useState<Record<string, number>>({});

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

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const updateMessageWidths = () => {
      const nextWidths: Record<string, number> = {};
      for (const line of stage.querySelectorAll<HTMLElement>(".stage-danmaku-line[data-danmaku-key]")) {
        const key = line.dataset.danmakuKey;
        if (!key) continue;
        const width = Math.round(line.getBoundingClientRect().width);
        if (width > 0) nextWidths[key] = width;
      }

      setMessageWidths((current) => {
        const currentKeys = Object.keys(current);
        const nextKeys = Object.keys(nextWidths);
        if (
          currentKeys.length === nextKeys.length &&
          nextKeys.every((key) => current[key] === nextWidths[key])
        ) {
          return current;
        }
        return nextWidths;
      });
    };

    updateMessageWidths();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateMessageWidths);
      return () => window.removeEventListener("resize", updateMessageWidths);
    }

    const observer = new ResizeObserver(updateMessageWidths);
    observer.observe(stage);
    for (const line of stage.querySelectorAll(".stage-danmaku-line[data-danmaku-key]")) {
      observer.observe(line);
    }
    return () => observer.disconnect();
  }, [messages]);

  return (
    <div
      ref={stageRef}
      className="stage-danmaku"
      aria-label="Floating danmaku behind character"
      style={{ "--stage-width": `${stageWidth}px` } as CSSProperties}
    >
      {messages.map((message, index) => {
        const messageKey = `${message.id}-${index}`;
        const lane = stableDanmakuLane(message);
        const speed = validDanmakuSpeed(message.danmaku_speed) || defaultDanmakuSpeed;
        const messageWidth = messageWidths[messageKey] || 0;
        const duration = (stageWidth + messageWidth + danmakuExitPadding) / (speed * danmakuVisualSpeedScale);
        return (
          <span
            key={`stage-${messageKey}`}
            data-danmaku-key={messageKey}
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

function getResolvedPresentation(state: CharacterState, presentation: HoshiaPresentation | null) {
  const fallback = getStagePresentation(state);
  if (!presentation) return fallback;
  const defaults = presentationDefaults[presentation.action] || fallback;
  return {
    label: presentation.label || defaults.label,
    expression: presentation.expression || defaults.expression,
    motion: presentation.motion || defaults.motion,
    cue: presentation.cue || defaults.cue
  };
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
  action,
  expression,
  motion,
  pngUrl,
  modelUrl,
  coreUrl
}: {
  state: CharacterState;
  action: string;
  expression: string;
  motion: string;
  pngUrl: string;
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
      data-action={action}
      data-expression={expression}
      data-motion={motion}
      data-runtime={runtimeState}
      aria-busy={runtimeState === "loading"}
    >
      <div className="live2d-canvas-host" ref={hostRef} aria-hidden={runtimeState !== "ready"} />
      <PngFallbackLayer state={state} runtimeState={runtimeState} pngUrl={pngUrl} />
    </div>
  );
}

function PngFallbackLayer({
  state,
  runtimeState,
  pngUrl
}: {
  state: CharacterState;
  runtimeState: Live2DRuntimeState;
  pngUrl: string;
}) {
  const isHidden = runtimeState === "ready";
  const resolvedPngUrl = resolveAssetUrl(pngUrl) || hoshiaCharacterUrl;

  return (
    <div className={`png-fallback-layer ${isHidden ? "hidden" : ""}`} data-fallback-state={state.toLowerCase()}>
      <span className="fallback-motion-ring" aria-hidden="true" />
      <img
        className="hoshia-character live2d-fallback"
        src={resolvedPngUrl}
        alt="星见终端临时角色层"
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

function resolveAssetUrl(path: string) {
  const value = String(path || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || /^data:/i.test(value) || /^blob:/i.test(value)) return value;
  if (value.startsWith(appBase)) return value;
  if (value.startsWith("/")) return `${appBase}${value.slice(1)}`;
  return `${appBase}${value}`;
}

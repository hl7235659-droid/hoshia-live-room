import type {
  PixelGameVisualAnimation,
  PixelGameVisualEntity,
  PixelGameVisualManifest,
  PixelGameVisualSprite
} from "../types";
import { gameAssetPath } from "./pixelGameData";

type PixiModule = typeof import("pixi.js");
type PixiContainer = import("pixi.js").Container;
type PixiSprite = import("pixi.js").Sprite;
type PixiTexture = import("pixi.js").Texture;
type PixiSpritesheet = import("pixi.js").Spritesheet;
type PixiSpritesheetData = ConstructorParameters<typeof import("pixi.js").Spritesheet>[1];

export type PixelGameVisualEffect = {
  id: string;
  kind: "hit" | "kill";
  x: number;
  y: number;
  age: number;
  duration: number;
  color: string;
  size: number;
  targetTypeId?: string;
  boss?: boolean;
};

export type PixelGameVisualRenderState = {
  elapsed: number;
  x: number;
  y: number;
  hurtCooldown: number;
  classId: string;
  specializationId: string;
  enemies: {
    id: string;
    typeId: string;
    x: number;
    y: number;
    size: number;
    color: string;
    boss?: boolean;
    phase: number;
  }[];
  projectiles: {
    id: string;
    x: number;
    y: number;
    color: string;
  }[];
  gems: {
    id: string;
    x: number;
    y: number;
    xp: number;
  }[];
  effects: PixelGameVisualEffect[];
};

export type PixelGameVisualRenderResult = {
  hoshia: boolean;
  enemies: Set<string>;
  projectiles: Set<string>;
  gems: Set<string>;
  effects: Set<string>;
};

export type PixelGameVisualRenderer = {
  worldLayer: PixiContainer;
  fxLayer: PixiContainer;
  readonly ready: boolean;
  render: (state: PixelGameVisualRenderState, camera: { x: number; y: number }) => PixelGameVisualRenderResult;
  destroy: () => void;
};

type SpriteBucket = {
  layer: PixiContainer;
  sprites: Map<string, PixiSprite>;
  visible: Set<string>;
};

type SpriteFrame = {
  texture: PixiTexture;
  anchorX: number;
  anchorY: number;
  scale: number;
};

type SpritePaint = {
  x: number;
  y: number;
  zIndex: number;
  scale?: number;
  alpha?: number;
  rotation?: number;
  tint?: number;
};

const fallbackEffectFrame = "effect/hit_default";

export function createPixelGameVisualRenderer(
  PIXI: PixiModule,
  visuals: PixelGameVisualManifest | null
): PixelGameVisualRenderer {
  PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.NEAREST;
  PIXI.settings.ROUND_PIXELS = true;

  const worldLayer = new PIXI.Container();
  const fxLayer = new PIXI.Container();
  worldLayer.sortableChildren = true;
  fxLayer.sortableChildren = true;

  const buckets = {
    hoshia: createBucket(worldLayer),
    enemies: createBucket(worldLayer),
    projectiles: createBucket(worldLayer),
    gems: createBucket(worldLayer),
    effects: createBucket(fxLayer)
  };
  const sheets = new Map<string, PixiSpritesheet>();
  const animationCache = new Map<string, PixiTexture[] | null>();
  const result: PixelGameVisualRenderResult = {
    hoshia: false,
    enemies: buckets.enemies.visible,
    projectiles: buckets.projectiles.visible,
    gems: buckets.gems.visible,
    effects: buckets.effects.visible
  };

  let ready = false;
  let destroyed = false;

  if (visuals?.atlases?.length) {
    void loadAtlases(PIXI, visuals, sheets, () => !destroyed).finally(() => {
      if (!destroyed) ready = true;
    });
  } else {
    ready = true;
  }

  function render(state: PixelGameVisualRenderState, camera: { x: number; y: number }) {
    resetResult(result);
    if (!visuals || destroyed || !ready) {
      worldLayer.visible = false;
      fxLayer.visible = false;
      return result;
    }

    worldLayer.visible = true;
    fxLayer.visible = true;

    renderGems(state, camera);
    renderProjectiles(state, camera);
    renderEnemies(state, camera);
    renderHoshia(state, camera);
    renderEffects(state, camera);

    pruneBucket(buckets.gems);
    pruneBucket(buckets.projectiles);
    pruneBucket(buckets.enemies);
    pruneBucket(buckets.hoshia);
    pruneBucket(buckets.effects);

    return result;
  }

  function renderGems(state: PixelGameVisualRenderState, camera: { x: number; y: number }) {
    const drops = visuals?.entities.drops || {};
    for (const gem of state.gems) {
      const entity = drops[gem.xp >= 6 ? "xp_large" : gem.xp >= 3 ? "xp_medium" : "xp_small"];
      const pulse = 1 + Math.sin(state.elapsed * 8 + gem.x * 0.02) * 0.08;
      if (renderEntitySprite(buckets.gems, gem.id, entity, "idle", state.elapsed, {
        x: gem.x - camera.x,
        y: gem.y - camera.y,
        zIndex: gem.y - 24,
        scale: 0.9 * pulse
      })) {
        result.gems.add(gem.id);
      }
    }
  }

  function renderProjectiles(state: PixelGameVisualRenderState, camera: { x: number; y: number }) {
    const entity = visuals?.entities.effects?.["effect/hit_signal"] || visuals?.entities.effects?.[fallbackEffectFrame];
    for (const projectile of state.projectiles) {
      if (renderEntitySprite(buckets.projectiles, projectile.id, entity, "idle", state.elapsed, {
        x: projectile.x - camera.x,
        y: projectile.y - camera.y,
        zIndex: projectile.y + 2,
        scale: 0.32,
        tint: colorToTint(PIXI, projectile.color)
      })) {
        result.projectiles.add(projectile.id);
      }
    }
  }

  function renderEnemies(state: PixelGameVisualRenderState, camera: { x: number; y: number }) {
    const enemies = visuals?.entities.enemies || {};
    const bosses = visuals?.entities.bosses || {};
    for (const enemy of state.enemies) {
      const entity = enemy.boss ? bosses[enemy.typeId] : enemies[enemy.typeId];
      const animationName = enemy.boss ? "move" : "move";
      if (renderEntitySprite(buckets.enemies, enemy.id, entity, animationName, state.elapsed + enemy.phase * 0.08, {
        x: enemy.x - camera.x,
        y: enemy.y - camera.y,
        zIndex: enemy.y,
        tint: undefined
      })) {
        result.enemies.add(enemy.id);
      }
    }
  }

  function renderHoshia(state: PixelGameVisualRenderState, camera: { x: number; y: number }) {
    const jobs = visuals?.entities.jobs || {};
    const entity = jobs[state.specializationId || state.classId] || jobs[state.classId] || visuals?.entities.hoshia;
    const hurt = state.hurtCooldown > 0;
    const animationTime = hurt ? Math.max(0, 0.45 - state.hurtCooldown) : state.elapsed;
    if (renderEntitySprite(buckets.hoshia, "hoshia", entity, hurt ? "hurt" : "idle", animationTime, {
      x: state.x - camera.x,
      y: state.y - camera.y,
      zIndex: state.y + 1
    })) {
      result.hoshia = true;
    }
  }

  function renderEffects(state: PixelGameVisualRenderState, camera: { x: number; y: number }) {
    const effects = visuals?.entities.effects || {};
    const enemies = visuals?.entities.enemies || {};
    const bosses = visuals?.entities.bosses || {};
    for (const effect of state.effects) {
      const target = effect.boss ? bosses[effect.targetTypeId || ""] : enemies[effect.targetTypeId || ""];
      const effectId = effect.kind === "kill"
        ? target?.effects?.killBurst || (effect.boss ? "effect/kill_burst_boss" : "effect/kill_burst_noise")
        : visuals?.fallbacks?.missingEffect || fallbackEffectFrame;
      const entity = effects[effectId] || effects[fallbackEffectFrame];
      const progress = clamp(effect.age / Math.max(0.001, effect.duration), 0, 1);
      const rendered = renderEntitySprite(buckets.effects, effect.id, entity, "idle", effect.age, {
        x: effect.x - camera.x,
        y: effect.y - camera.y,
        zIndex: effect.y + 1000,
        scale: (effect.kind === "kill" ? 0.9 : 0.45) * (1 + progress * 0.55),
        alpha: 1 - progress,
        tint: colorToTint(PIXI, effect.color)
      });
      if (rendered) result.effects.add(effect.id);
    }
  }

  function renderEntitySprite(
    bucket: SpriteBucket,
    id: string,
    entity: PixelGameVisualEntity | undefined,
    animationName: string,
    timeSeconds: number,
    paint: SpritePaint
  ) {
    const frame = resolveFrame(entity?.sprite, animationName, timeSeconds);
    if (!frame) return false;
    const sprite = obtainSprite(PIXI, bucket, id, frame.texture);
    if (sprite.texture !== frame.texture) sprite.texture = frame.texture;
    sprite.anchor.set(frame.anchorX, frame.anchorY);
    const scale = frame.scale * (paint.scale ?? 1);
    sprite.scale.set(scale);
    sprite.position.set(Math.round(paint.x), Math.round(paint.y));
    sprite.zIndex = paint.zIndex;
    sprite.alpha = paint.alpha ?? 1;
    sprite.rotation = paint.rotation ?? 0;
    sprite.tint = paint.tint ?? 0xffffff;
    sprite.visible = true;
    bucket.visible.add(id);
    return true;
  }

  function resolveFrame(sprite: PixelGameVisualSprite | undefined, animationName: string, timeSeconds: number): SpriteFrame | null {
    if (!sprite) return null;
    const animation = pickAnimation(sprite, animationName);
    if (animation) {
      const textures = resolveAnimationTextures(sprite, animation);
      if (!textures?.length) return null;
      const fps = clamp(Number(animation.fps || 6), 1, 30);
      const frameIndex = animation.loop === false
        ? Math.min(textures.length - 1, Math.floor(Math.max(0, timeSeconds) * fps))
        : Math.floor(Math.max(0, timeSeconds) * fps) % textures.length;
      const anchor = resolveAnchor(animation.anchor);
      return {
        texture: textures[frameIndex],
        anchorX: anchor.x,
        anchorY: anchor.y,
        scale: Number(animation.scale || 1)
      };
    }

    const atlasId = sprite.atlas || "";
    if (sprite.frame) {
      const texture = textureForFrame(atlasId, sprite.frame);
      if (!texture) return null;
      const anchor = resolveAnchor();
      return { texture, anchorX: anchor.x, anchorY: anchor.y, scale: 1 };
    }
    if (sprite.prefix) {
      const texture = textureForFrame(atlasId, `${sprite.prefix}/${animationName}_0`) ||
        textureForFrame(atlasId, `${sprite.prefix}/idle_0`) ||
        textureForFrame(atlasId, sprite.prefix);
      if (!texture) return null;
      const anchor = resolveAnchor();
      return { texture, anchorX: anchor.x, anchorY: anchor.y, scale: 1 };
    }
    return null;
  }

  function resolveAnimationTextures(sprite: PixelGameVisualSprite, animation: PixelGameVisualAnimation) {
    const atlasId = animation.atlas || sprite.atlas || "";
    const cacheKey = `${atlasId}:${animation.frames.join("|")}`;
    if (animationCache.has(cacheKey)) return animationCache.get(cacheKey) || null;
    const textures: PixiTexture[] = [];
    for (const frame of animation.frames) {
      const texture = textureForFrame(atlasId, frame);
      if (!texture) {
        animationCache.set(cacheKey, null);
        return null;
      }
      textures.push(texture);
    }
    animationCache.set(cacheKey, textures);
    return textures;
  }

  function textureForFrame(atlasId: string, frame: string) {
    const sheet = sheets.get(atlasId);
    if (!sheet) return null;
    return sheet.textures[frame] ||
      sheet.textures[`${frame}.png`] ||
      sheet.textures[frame.replace(/\.png$/, "")] ||
      null;
  }

  function destroy() {
    destroyed = true;
    destroyBucket(buckets.gems);
    destroyBucket(buckets.projectiles);
    destroyBucket(buckets.enemies);
    destroyBucket(buckets.hoshia);
    destroyBucket(buckets.effects);
    for (const sheet of sheets.values()) sheet.destroy(true);
    sheets.clear();
    animationCache.clear();
    worldLayer.parent?.removeChild(worldLayer);
    fxLayer.parent?.removeChild(fxLayer);
    worldLayer.destroy({ children: true, texture: false, baseTexture: false });
    fxLayer.destroy({ children: true, texture: false, baseTexture: false });
  }

  return {
    worldLayer,
    fxLayer,
    get ready() {
      return ready;
    },
    render,
    destroy
  };
}

async function loadAtlases(
  PIXI: PixiModule,
  visuals: PixelGameVisualManifest,
  sheets: Map<string, PixiSpritesheet>,
  shouldKeep: () => boolean
) {
  await Promise.all(visuals.atlases.map(async (atlas) => {
    try {
      if (!shouldKeep()) return;
      const imageUrl = resolveVisualAssetUrl(visuals, atlas.image);
      const dataUrl = resolveVisualAssetUrl(visuals, atlas.data);
      const response = await fetch(dataUrl, { cache: "no-cache" });
      if (!response.ok) return;
      const data = await response.json() as Record<string, unknown>;
      const meta = data.meta && typeof data.meta === "object" ? data.meta as Record<string, unknown> : {};
      const sheetData = {
        ...data,
        meta: {
          ...meta,
          image: typeof meta.image === "string" ? meta.image : imageUrl
        }
      } as unknown as PixiSpritesheetData;
      const texture = await PIXI.Texture.fromURL(imageUrl, { scaleMode: PIXI.SCALE_MODES.NEAREST });
      texture.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
      const sheet = new PIXI.Spritesheet(texture, sheetData, imageUrl);
      await sheet.parse();
      if (!shouldKeep()) {
        sheet.destroy(true);
        return;
      }
      for (const frameTexture of Object.values(sheet.textures)) {
        frameTexture.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
        frameTexture.defaultAnchor.set(0.5, 0.5);
      }
      sheets.set(atlas.id, sheet);
    } catch {
      // A missing or malformed atlas should never break the game loop; geometry fallback will render instead.
    }
  }));
}

function createBucket(layer: PixiContainer): SpriteBucket {
  return {
    layer,
    sprites: new Map(),
    visible: new Set()
  };
}

function obtainSprite(PIXI: PixiModule, bucket: SpriteBucket, id: string, texture: PixiTexture) {
  const existing = bucket.sprites.get(id);
  if (existing) return existing;
  const sprite = new PIXI.Sprite(texture);
  sprite.texture.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
  bucket.sprites.set(id, sprite);
  bucket.layer.addChild(sprite);
  return sprite;
}

function pruneBucket(bucket: SpriteBucket) {
  for (const [id, sprite] of bucket.sprites) {
    if (bucket.visible.has(id)) continue;
    sprite.parent?.removeChild(sprite);
    sprite.destroy({ texture: false, baseTexture: false });
    bucket.sprites.delete(id);
  }
}

function destroyBucket(bucket: SpriteBucket) {
  for (const sprite of bucket.sprites.values()) {
    sprite.parent?.removeChild(sprite);
    sprite.destroy({ texture: false, baseTexture: false });
  }
  bucket.sprites.clear();
  bucket.visible.clear();
}

function resetResult(result: PixelGameVisualRenderResult) {
  result.hoshia = false;
  result.enemies.clear();
  result.projectiles.clear();
  result.gems.clear();
  result.effects.clear();
}

function pickAnimation(sprite: PixelGameVisualSprite, preferred: string) {
  const animations = sprite.animations || {};
  return animations[preferred] || animations.move || animations.idle || null;
}

function resolveAnchor(anchor?: { x: number; y: number }) {
  return {
    x: clamp(Number(anchor?.x ?? 0.5), 0, 1),
    y: clamp(Number(anchor?.y ?? 0.5), 0, 1)
  };
}

function resolveVisualAssetUrl(visuals: PixelGameVisualManifest, path: string) {
  if (/^(?:https?:|data:|blob:|\/)/i.test(path)) return path;
  const assetBase = visuals.assetBase || "assets/game/";
  const prefix = assetBase.endsWith("/") ? assetBase : `${assetBase}/`;
  return gameAssetPath(`${prefix}${path}`);
}

function colorToTint(PIXI: PixiModule, color: string) {
  try {
    return PIXI.utils.string2hex(color);
  } catch {
    return 0xffffff;
  }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');
const gameRoot = path.join(frontendRoot, 'public', 'assets', 'game');

const visualsPath = path.join(gameRoot, 'visuals.v1.json');
const manifestPath = path.join(gameRoot, 'manifest.v1.json');
const creditsPath = path.join(gameRoot, 'CREDITS.md');

const failures = [];
const checkedRefs = [];
const atlasFrames = new Map();

function fail(message) {
  failures.push(message);
}

function readUtf8(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`cannot read ${path.relative(frontendRoot, filePath)}: ${error.message}`);
    return '';
  }
}

function readJson(filePath) {
  const text = readUtf8(filePath);
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON ${path.relative(frontendRoot, filePath)}: ${error.message}`);
    return null;
  }
}

function normalizeAssetRef(ref) {
  return ref.replaceAll('\\', '/').replace(/^\/+/, '');
}

function resolveAssetRef(ref) {
  const normalized = normalizeAssetRef(ref);
  const localRef = normalized.startsWith('assets/game/')
    ? normalized.slice('assets/game/'.length)
    : normalized;
  return {
    displayRef: localRef,
    absolutePath: path.resolve(gameRoot, localRef),
  };
}

function assertRelativeFile(label, ref) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    fail(`${label} must be a non-empty relative path`);
    return;
  }

  if (path.isAbsolute(ref) || /^[A-Za-z]:[\\/]/.test(ref)) {
    fail(`${label} must not be absolute: ${ref}`);
    return;
  }

  const { displayRef, absolutePath } = resolveAssetRef(ref);
  const relativeFromGameRoot = path.relative(gameRoot, absolutePath);
  if (relativeFromGameRoot.startsWith('..') || path.isAbsolute(relativeFromGameRoot)) {
    fail(`${label} escapes assets/game: ${ref}`);
    return;
  }

  checkedRefs.push(`${label}: ${displayRef}`);

  if (!existsSync(absolutePath)) {
    fail(`${label} missing: ${displayRef}`);
    return;
  }

  if (!statSync(absolutePath).isFile()) {
    fail(`${label} is not a file: ${displayRef}`);
  }
}

function walkVisualRefs(node, trail = '$') {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((item, index) => walkVisualRefs(item, `${trail}[${index}]`));
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    const nextTrail = `${trail}.${key}`;
    if ((key === 'portrait' || key === 'preview' || key === 'creditsFile') && typeof value === 'string') {
      assertRelativeFile(nextTrail, value);
      continue;
    }

    walkVisualRefs(value, nextTrail);
  }
}

function checkAtlases(visuals) {
  if (!Array.isArray(visuals?.atlases)) {
    fail('visuals.atlases must be an array');
    return;
  }

  for (const atlas of visuals.atlases) {
    const id = atlas?.id ?? '<missing-id>';
    assertRelativeFile(`atlas ${id} image`, atlas?.image);
    assertRelativeFile(`atlas ${id} data`, atlas?.data);
    const dataRef = resolveAssetRef(atlas?.data ?? '');
    if (existsSync(dataRef.absolutePath)) {
      const atlasData = readJson(dataRef.absolutePath);
      atlasFrames.set(id, new Set(Object.keys(atlasData?.frames || {})));
    }
  }
}

function assertAtlasFrame(label, atlasId, frame) {
  if (typeof atlasId !== 'string' || atlasId.trim() === '') {
    fail(`${label} missing atlas id`);
    return;
  }
  if (typeof frame !== 'string' || frame.trim() === '') {
    fail(`${label} missing frame`);
    return;
  }
  const frames = atlasFrames.get(atlasId);
  if (!frames) {
    fail(`${label} references unknown atlas: ${atlasId}`);
    return;
  }
  if (!frames.has(frame)) {
    fail(`${label} missing frame in atlas ${atlasId}: ${frame}`);
  }
}

function walkSpriteRefs(node, trail = '$') {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((item, index) => walkSpriteRefs(item, `${trail}[${index}]`));
    return;
  }

  if (node.sprite && typeof node.sprite === 'object') {
    const sprite = node.sprite;
    if (sprite.frame) {
      assertAtlasFrame(`${trail}.sprite.frame`, sprite.atlas, sprite.frame);
    }
    for (const [name, animation] of Object.entries(sprite.animations || {})) {
      if (!Array.isArray(animation?.frames)) {
        fail(`${trail}.sprite.animations.${name}.frames must be an array`);
        continue;
      }
      for (const frame of animation.frames) {
        assertAtlasFrame(`${trail}.sprite.animations.${name}`, animation.atlas, frame);
      }
    }
  }

  if (typeof node.icon === 'string') {
    assertAtlasFrame(`${trail}.icon`, 'ui-icons', node.icon);
  }

  for (const [key, value] of Object.entries(node)) {
    if (key !== 'sprite') {
      walkSpriteRefs(value, `${trail}.${key}`);
    }
  }
}

function scanPublicText(filePath) {
  const label = path.relative(frontendRoot, filePath);
  const text = readUtf8(filePath);
  if (!text) {
    return;
  }

  const checks = [
    {
      name: 'Windows drive absolute path',
      pattern: /(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]{1,2}/,
    },
    {
      name: 'Windows UNC absolute path',
      pattern: /\\\\[A-Za-z0-9_.-]+[\\/][^"'`\s]+/,
    },
    {
      name: 'sensitive deployment keyword',
      pattern: /\b(token|secret|tunnel|cloudflared|trycloudflare)\b/i,
    },
  ];

  for (const check of checks) {
    if (check.pattern.test(text)) {
      fail(`${label} contains ${check.name}`);
    }
  }
}

const visuals = readJson(visualsPath);
if (visuals) {
  checkAtlases(visuals);
  walkVisualRefs(visuals);
  walkSpriteRefs(visuals.entities);
  if (visuals.fallbacks?.missingIcon) assertAtlasFrame('visuals.fallbacks.missingIcon', 'ui-icons', visuals.fallbacks.missingIcon);
  if (visuals.fallbacks?.missingActor) assertAtlasFrame('visuals.fallbacks.missingActor', 'actors', visuals.fallbacks.missingActor);
  if (visuals.fallbacks?.missingEffect) assertAtlasFrame('visuals.fallbacks.missingEffect', 'combat', visuals.fallbacks.missingEffect);
}

for (const filePath of [visualsPath, manifestPath, creditsPath]) {
  if (!existsSync(filePath)) {
    fail(`required scan file missing: ${path.relative(frontendRoot, filePath)}`);
    continue;
  }
  scanPublicText(filePath);
}

console.log(`[game-visuals] checked ${checkedRefs.length} visual file references`);

if (failures.length > 0) {
  console.error('[game-visuals] failed');
  for (const message of failures) {
    console.error(`- ${message}`);
  }
  process.exitCode = 1;
} else {
  console.log('[game-visuals] ok');
}

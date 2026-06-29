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
const jobsPath = path.join(gameRoot, 'data', 'jobs.v1.json');
const weaponsPath = path.join(gameRoot, 'data', 'weapons.v1.json');

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

function hasAtlasFrame(atlasId, frame) {
  return typeof atlasId === 'string' && typeof frame === 'string' && atlasFrames.get(atlasId)?.has(frame);
}

function assertSpriteAnimations(label, entry, requiredAnimations = []) {
  const animations = entry?.sprite?.animations;
  if (!animations || typeof animations !== 'object' || Array.isArray(animations)) {
    fail(`${label} must have sprite animations`);
    return;
  }

  const animationNames = Object.keys(animations);
  if (animationNames.length === 0) {
    fail(`${label} must have at least one sprite animation`);
  }

  for (const name of requiredAnimations) {
    const animation = animations[name];
    if (!animation) {
      fail(`${label} missing sprite animation: ${name}`);
      continue;
    }
    if (!Array.isArray(animation.frames) || animation.frames.length === 0) {
      fail(`${label}.sprite.animations.${name}.frames must be a non-empty array`);
    }
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

function checkJobsCoverage(visuals, jobsData) {
  const jobs = jobsData?.jobs;
  if (!Array.isArray(jobs)) {
    fail('data/jobs.v1.json jobs must be an array');
    return;
  }

  const jobVisuals = visuals?.entities?.jobs;
  if (!jobVisuals || typeof jobVisuals !== 'object' || Array.isArray(jobVisuals)) {
    fail('visuals.entities.jobs must be an object');
    return;
  }

  for (const job of jobs) {
    const id = job?.id;
    if (typeof id !== 'string' || id.trim() === '') {
      fail('data/jobs.v1.json contains a job without a valid id');
      continue;
    }
    const visual = jobVisuals[id];
    if (!visual) {
      fail(`job ${id} missing visuals.entities.jobs entry`);
      continue;
    }
    assertSpriteAnimations(`visuals.entities.jobs.${id}`, visual);
  }
}

function findWeaponVisual(visuals, weaponId) {
  const groups = ['weapons', 'starterWeapons'];
  for (const group of groups) {
    const entry = visuals?.entities?.[group]?.[weaponId];
    if (entry) {
      return { group, entry };
    }
  }
  return null;
}

function hasEffectReference(entry) {
  return (
    entry?.effects &&
    typeof entry.effects === 'object' &&
    !Array.isArray(entry.effects) &&
    Object.values(entry.effects).some((value) => typeof value === 'string' && value.trim() !== '')
  );
}

function assertWeaponEffectReferences(label, visuals, entry) {
  if (!entry?.effects || typeof entry.effects !== 'object' || Array.isArray(entry.effects)) {
    return;
  }

  for (const [effectName, effectRef] of Object.entries(entry.effects)) {
    if (typeof effectRef !== 'string' || effectRef.trim() === '') {
      fail(`${label}.effects.${effectName} must be a non-empty effect reference`);
      continue;
    }
    if (!visuals?.entities?.effects?.[effectRef] && !hasAtlasFrame('combat', effectRef)) {
      fail(`${label}.effects.${effectName} references missing effect or combat atlas frame: ${effectRef}`);
    }
  }
}

function checkWeaponCoverage(visuals, weaponsData) {
  const weapons = weaponsData?.weapons;
  if (!Array.isArray(weapons)) {
    fail('data/weapons.v1.json weapons must be an array');
    return;
  }

  for (const weapon of weapons) {
    const id = weapon?.id;
    if (typeof id !== 'string' || id.trim() === '') {
      fail('data/weapons.v1.json contains a weapon without a valid id');
      continue;
    }

    const visualMatch = findWeaponVisual(visuals, id);
    if (!visualMatch) {
      fail(`weapon ${id} missing from visuals.entities.weapons or visuals.entities.starterWeapons`);
      continue;
    }

    const { group, entry } = visualMatch;
    const label = `visuals.entities.${group}.${id}`;
    if (typeof entry.icon !== 'string' || entry.icon.trim() === '') {
      fail(`${label}.icon must be a non-empty ui-icons frame`);
    }
    if (!entry?.sprite?.frame && !hasEffectReference(entry)) {
      fail(`${label} must have sprite.frame or at least one effect reference`);
    }
    assertWeaponEffectReferences(label, visuals, entry);
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
const jobsData = readJson(jobsPath);
const weaponsData = readJson(weaponsPath);
if (visuals) {
  checkAtlases(visuals);
  walkVisualRefs(visuals);
  walkSpriteRefs(visuals.entities);
  checkJobsCoverage(visuals, jobsData);
  checkWeaponCoverage(visuals, weaponsData);
  assertSpriteAnimations('visuals.entities.hoshia', visuals.entities?.hoshia, [
    'idle',
    'run',
    'attack',
    'cast',
    'hurt',
    'level_up',
    'ko',
  ]);
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

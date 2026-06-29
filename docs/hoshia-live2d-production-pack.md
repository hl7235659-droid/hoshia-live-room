# Hoshia Live2D Production Pack

This pack defines the first real Cubism model target for Hoshia. The current
room character PNG remains the fallback artwork; the real model should be drawn
as a new rigging-friendly standing pose.

## Reference Asset

- Standing pose reference: `frontend/public/assets/hoshia-live2d-standing-reference.png`
- Current fallback stage art: `frontend/public/assets/hoshia-character-cutout.png`

Use the standing pose reference for PSD composition and rigging proportions. Use
the fallback stage art only for identity continuity.

## Character Target

- Name: Hoshia
- Role: friends-only AI live room host
- Style: four-head chibi anime, thick dark line art, white sticker outline,
  bright flat colors, small crisp shadows
- Identity: white/silver long hair, purple eyes, cat ears, cat tail,
  blue-and-white sporty idol outfit, headset microphone, cat-paw hair clip,
  star accents, room-key charm
- Pose: front or slight 3/4 standing pose, arms away from torso, legs separated,
  tail separated from body, no crossed limbs

## PSD Layer Requirements

Canvas target: 3000 x 4500 px or larger, transparent background.

Required top groups:

```text
Hoshia
  Guide_Not_For_Export
  FX
  Face
  Hair
  Cat_Ears
  Body
  Outfit
  Arms
  Legs
  Tail
  Accessories
  Sticker_Outline
```

Minimum rigging layers:

- Face: head base, face shadow, blush, nose, human ears
- Eyes: whites, irises, pupils, highlights, upper lids, lower lids, smile eyes,
  error eyes
- Mouth: neutral, smile, open A, open I, open U, open E, open O, surprised,
  error
- Hair: back base, left/right back hair, side hair, center bang, left/right
  bangs, ahoge, highlights
- Cat ears: left/right bases, inners, tips
- Tail: base, tip, shadow
- Body: neck, torso, chest, waist, shoulders, hips
- Outfit: vest, collar, jacket left/right/back, arm warmers, skirt waistband,
  front/side/back pleats, hem line
- Arms: upper arms, forearms, hands, finger groups
- Legs: thighs, knees, calves, socks, shoes, shoe details
- Accessories: headset, microphone, paw clip, key charm, ribbons, star pieces

All hidden areas that will be exposed by head/body rotation or physics must be
painted in.

## Cubism Parameters

Use standard Cubism parameter naming where practical:

- `ParamAngleX`, `ParamAngleY`, `ParamAngleZ`
- `ParamBodyAngleX`, `ParamBodyAngleY`, `ParamBodyAngleZ`
- `ParamEyeLOpen`, `ParamEyeROpen`
- `ParamEyeBallX`, `ParamEyeBallY`
- `ParamMouthOpenY`, `ParamMouthForm`
- `ParamBreath`
- Hair physics output parameters for bangs, side hair, back hair, and ahoge
- Ear physics/pose parameters for forward, relaxed, lowered, and alert states
- Tail physics/pose parameters for idle sway, speaking rhythm, and error stiffen
- Skirt physics parameters for light bounce

## Expressions

Export these expression files with matching names:

- `idle_smile.exp3.json`
- `happy.exp3.json`
- `listening.exp3.json`
- `thinking.exp3.json`
- `speaking.exp3.json`
- `surprised.exp3.json`
- `error.exp3.json`
- `sleepy.exp3.json`

## Motions

Export these motion groups so the frontend can call them directly:

- `idle_loop`
- `listen_start`
- `think_loop`
- `speak_loop`
- `happy_react`
- `error_recover`
- `afk_idle`

The first export can keep each group to one motion file. Additional variants can
be added later by placing more files in the same group.

## Export Target

Put final runtime assets under:

```text
frontend/public/live2d/hoshia/
  hoshia.model3.json
  hoshia.moc3
  hoshia.physics3.json
  textures/
  expressions/
  motions/
```

The frontend model URL should be:

```text
VITE_LIVE2D_MODEL_URL=/live/live2d/hoshia/hoshia.model3.json
```

Cubism Core should be placed at:

```text
frontend/public/live2d/runtime/live2dcubismcore.min.js
```

## Acceptance Checks

- Model opens in Cubism Viewer without missing file warnings.
- All expressions apply by the exact names listed above.
- All motion groups can be triggered by the exact names listed above.
- Idle motion loops cleanly for at least 30 seconds.
- Speaking motion reads clearly at mobile size without moving the face under UI.
- Listening state moves ears forward or head subtly toward chat.
- Error state lowers ears or stiffens tail without looking broken.
- Frontend can load `hoshia.model3.json`; if any runtime file is absent, the PNG
  fallback remains visible.

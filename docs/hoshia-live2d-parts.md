# Hoshia Live2D Parts Checklist

This document captures the current Hoshia character direction and future Live2D part requirements.

## Character Direction

- Name: Hoshia
- Role: friends-only AI live room host
- Personality: sunny, intimate, cute, active, healthy
- Style: four-head chibi cartoon, thick dark lines, white sticker outline, flat colors, small hard-edge shadows
- Palette: sky blue, white, small yellow star accents
- Core traits: white/silver long hair, purple eyes, cat ears, cat tail, sporty vest, puffy sporty skirt, headset, cat-paw hair clip, room-key charm

## PSD Requirements

- Canvas: front standing pose, recommended 3000 x 4500 px or larger, transparent background.
- Pose: front or slight 3/4. Arms should not stick to the body. Legs should be slightly separated.
- Proportion: four-head body, legs around two heads long.
- Lines: separate line art and color blocks. Keep the white sticker outline on its own layer if possible.
- Rigging friendly: fill hidden areas for hair, ears, tail, skirt, arms, and legs.

## Suggested Groups

```text
Hoshia
├── Guide_Not_For_Export
├── FX
├── Face
├── Hair
├── Cat_Ears
├── Body
├── Outfit
├── Arms
├── Legs
├── Tail
├── Accessories
└── Sticker_Outline
```

## Face

- `Head_Base`
- `Face_Shadow`
- `Blush_L` / `Blush_R`
- `Nose`
- `Ear_Human_L` / `Ear_Human_R`

Eyes:

- `Eye_L_White` / `Eye_R_White`
- `Eye_L_Iris` / `Eye_R_Iris`
- `Eye_L_Pupil` / `Eye_R_Pupil`
- `Eye_L_Highlight` / `Eye_R_Highlight`
- `Eye_L_UpperLid` / `Eye_R_UpperLid`
- `Eye_L_LowerLid` / `Eye_R_LowerLid`
- `Eye_L_Smile` / `Eye_R_Smile`
- `Eye_L_Error` / `Eye_R_Error`

Mouth:

- `Mouth_Neutral`
- `Mouth_Smile`
- `Mouth_Open_A`
- `Mouth_Open_I`
- `Mouth_Open_U`
- `Mouth_Open_E`
- `Mouth_Open_O`
- `Mouth_Surprised`
- `Mouth_Error`

## Hair

White/silver long hair is a key identifier. Use large cartoon hair pieces:

- `Hair_Back_Base`
- `Hair_Back_L` / `Hair_Back_R`
- `Hair_Side_L` / `Hair_Side_R`
- `Hair_Bang_Center`
- `Hair_Bang_L` / `Hair_Bang_R`
- `Hair_Ahoge`
- `Hair_Highlight_01` / `Hair_Highlight_02`

Rigging notes:

- Bangs follow head angle with small movement.
- Side and back hair use light physics.
- Highlights should follow their hair pieces.

## Cat Ears And Tail

Cat ears:

- `CatEar_L_Base` / `CatEar_R_Base`
- `CatEar_L_Inner` / `CatEar_R_Inner`
- `CatEar_L_Tip` / `CatEar_R_Tip`

Tail:

- `Tail_Base`
- `Tail_Tip`
- `Tail_Shadow`

Motion ideas:

- `IDLE`: slow bounce and tail sway.
- `LISTENING`: ears lean forward.
- `SPEAKING`: small rhythmic ear and tail motion.
- `ERROR`: ears lower and tail stiffens.

## Body And Outfit

Body:

- `Neck`
- `Torso_Base`
- `Chest_Base`
- `Waist_Base`
- `Shoulder_L` / `Shoulder_R`
- `Hip_Base`

Outfit:

- `Sport_Vest_Base`
- `Sport_Vest_Collar`
- `Sport_Vest_Hem`
- `Open_Jacket_Back`
- `Open_Jacket_L`
- `Open_Jacket_R`
- `Arm_Warmer_L` / `Arm_Warmer_R`
- `Skirt_Waistband`
- `Skirt_Front_Center`
- `Skirt_Front_L` / `Skirt_Front_R`
- `Skirt_Side_L` / `Skirt_Side_R`
- `Skirt_Back`
- `Skirt_Hem_Line`

Skirt notes:

- Must read as a puffy sporty short skirt, not shorts.
- Avoid obvious exposed safety shorts.
- Use rounded large pleats with complete lower edges for bounce/physics.

## Arms And Legs

Arms:

- `UpperArm_L` / `UpperArm_R`
- `Forearm_L` / `Forearm_R`
- `Hand_L` / `Hand_R`
- `Finger_Group_L` / `Finger_Group_R`

Legs:

- `Thigh_L` / `Thigh_R`
- `Knee_L` / `Knee_R`
- `Calf_L` / `Calf_R`
- `Sock_L` / `Sock_R`
- `Shoe_L_Base` / `Shoe_R_Base`
- `Shoe_L_Detail` / `Shoe_R_Detail`

Requirements:

- Keep the long-leg feeling within the four-head proportion.
- Shoes should be blocky and readable on mobile.
- Arms should stay away from the torso for rigging.

## Expression List

- `idle_smile`
- `happy`
- `listening`
- `thinking`
- `speaking`
- `surprised`
- `error`
- `sleepy`

## Motion List

- `idle_loop`
- `enter_room`
- `listen_start`
- `think_loop`
- `speak_loop`
- `happy_react`
- `error_recover`
- `afk_idle`

## Delivery Checks

- Hidden areas are filled for rigging.
- White/silver hair is separated into large pieces.
- Cat ears and tail are independent.
- Eyes include open/closed/smile/error variants.
- Mouth includes A/I/U/E/O shapes.
- Skirt pleats are separate pieces, not one flat block.
- Arms are separated from the torso.
- No real brand logo or readable brand text is used.

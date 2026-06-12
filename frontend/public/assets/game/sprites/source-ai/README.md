# AI Source Notes

This folder is reserved for non-sensitive notes about AI-generated Hoshia pixel-game source assets.

- Intended scope: Hoshia character variants, weapons, class icons/portraits, enemy remaps, boss themes, and neon combat effects.
- Final assets are curated and may be cropped, resized, recolored, transparency-cleaned, renamed, and packed into game atlases.
- Do not store local absolute paths, private runtime details, deployment links, raw prompts with private context, or unreviewed third-party packs here.

## Current committed sources

- `hoshia-sprite-sheet.ai-source.png`: AI-generated Hoshia player sprite sheet source for idle, run, attack, cast, hurt, level-up, and KO frames.
- `weapon-vfx-sheet.ai-source.png`: AI-generated weapon, hit, burst, and ambient-effect sheet source used for 20 weapon visuals and 6 biome overlay loops.

The runtime uses curated atlas outputs in `sprites/atlases/*-ai.v1.png` and matching JSON metadata, not these large source sheets directly.

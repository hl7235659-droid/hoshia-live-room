# Hoshia Cubism Export Directory

Put the final exported Cubism runtime assets here.

Expected first-version layout:

```text
hoshia.model3.json
hoshia.moc3
hoshia.physics3.json
textures/
expressions/
motions/
```

The first model should expose motions that match the current room state mapping:

```text
IDLE       -> idle_loop
LISTENING  -> listen_start
THINKING   -> think_loop
SPEAKING   -> speak_loop
ERROR      -> error_recover
```

Expression names should remain compatible with the frontend mapping where possible:

```text
idle_smile
listening
thinking
speaking
error
```

Set the frontend model URL to:

```text
VITE_LIVE2D_MODEL_URL=/live/live2d/hoshia/hoshia.model3.json
```

Do not create placeholder `.model3.json` or `.moc3` files. The frontend already
falls back to the PNG character when real model files are missing.

Runtime fallback contract:

- Empty `VITE_LIVE2D_MODEL_URL`: PNG fallback only.
- Missing or invalid model URL: PNG fallback remains visible and the adapter marks
  `data-runtime="error"`.
- Loaded model URL: canvas becomes visible and the PNG fallback is hidden.

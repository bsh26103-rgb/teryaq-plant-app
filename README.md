---
title: Teryaq Plant Identifier
emoji: 🌿
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# 🌿 Teryaq — Plant Recognition Flask API

AI-powered medicinal & toxic plant identification — Tafila Technical
University graduation project. Connects to the models trained in
`Plant_Training_25Classes.ipynb`. It loads the fine-tuned ResNet50 and
ConvNeXt-Tiny checkpoints once at startup and combines their predictions
with weighted-average ensembling.

## What's implemented

- **Cache Models** — both models load once when the app starts, not per request.
- **Error Handling** — bad file type, corrupted image, oversized upload, and
  generic server errors all return a clean JSON message instead of crashing.
- **Ensemble** — ResNet50 + ConvNeXt-Tiny, weighted average of both models'
  softmax outputs (see `ENSEMBLE_WEIGHTS` in `app.py`).
- **Top-3 Predictions** — every response includes the top 3 classes with confidence.
- **Confidence Threshold + Temperature Scaling** — logits are softened with a
  temperature before softmax, then bucketed into `ok` / `low_confidence` / `unknown`.
- **Logging** — every prediction is appended to `prediction_log.csv`.
- **Basic API** — `/health`, `/predict`, `/plants`, `/plants/<name>`, `/stats`, `/chat`.
- **Out-of-distribution check** — nearest-centroid distance in ResNet50's
  feature space flags images that don't look like any of the 25 plants at
  all (`status: "not_a_plant"`), separate from the confidence threshold.
- **Grad-CAM** — real attention heatmap (ResNet50, layer4) returned with
  every confident prediction.
- **Chatbot** — keyword-matched Q&A against `plants.json`, with mood-based
  suggestions and bilingual (AR/EN) focused answers. No external LLM/API —
  fully self-contained.

## Deployment

This Space runs the app in a Docker container (see `Dockerfile`) so it's
reachable at a permanent public URL, always — no Colab session or ngrok
tunnel required. On the free CPU tier the Space goes to sleep after a
period of no traffic and wakes back up automatically (a few seconds delay)
on the next visit.

**Note:** the free tier's filesystem is not persistent across restarts —
`prediction_log.csv` (and therefore `/stats` and `/dashboard-stats`) resets
whenever the Space sleeps/wakes or is redeployed. This doesn't affect
`/predict` itself, only the cumulative usage counters.

## Run it locally

```bash
pip install -r requirements.txt
python app.py
```

Runs on `http://localhost:5000` by default (unchanged from before). Point
`MODELS_DIR` at your checkpoints if they're not in `./models`:

```bash
export MODELS_DIR="/your/path/here"
```

## Test it

```bash
curl -X POST -F "image=@test_plant.jpg" http://localhost:5000/predict
```

Example response:

```json
{
  "status": "ok",
  "top3": [
    {"name": "Rosemary", "confidence": 84.3},
    {"name": "Sage", "confidence": 9.1},
    {"name": "Thyme", "confidence": 3.2}
  ],
  "prediction": "Rosemary",
  "confidence": 84.3,
  "inference_time_ms": 187.4,
  "message": null
}
```

## Notes / next tuning step

`SOFTMAX_TEMPERATURE` (default `1.0`) and the two confidence thresholds are
reasonable starting points, not fitted values. If you have time before the
defense, properly fit the temperature against your validation set (Temperature
Scaling) so the confidence numbers are calibrated instead of guessed — that
was flagged as a real issue (the models tend to be overconfident, including
on images that aren't even one of the 25 classes).

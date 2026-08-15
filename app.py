"""
Flask API — Smart Plant Recognition System
--------------------------------------------
Serves predictions using an ensemble of the ResNet50 and ConvNeXt-Tiny
models trained in Plant_Training_25Classes.ipynb.
"""

import os
import re
import io
import csv
import time
import random
import base64
import datetime
import json

import numpy as np
import torch
import torch.nn as nn
from torch.nn.functional import softmax
from torchvision import transforms
from torchvision.models import resnet50, convnext_tiny
from PIL import Image, UnidentifiedImageError

from flask import Flask, request, jsonify, render_template
from flask_cors import CORS

# Config

# Same folder the training notebook saves checkpoints to.
MODELS_DIR = os.environ.get("MODELS_DIR", "./models")

RESNET_CKPT   = os.path.join(MODELS_DIR, "ResNet50_FT_best.pth")
CONVNEXT_CKPT = os.path.join(MODELS_DIR, "ConvNeXt_Tiny_FT_best.pth")
CLASS_NAMES_FILE = os.path.join(MODELS_DIR, "class_names_25.txt")

# Best weights found in the official model-comparison notebook's ensemble
# weight search (50/50, 55/45, and 60/40 were tied at 97.05%; 65/35=97.01% | 70/30=96.97%)
ENSEMBLE_WEIGHTS = [0.6, 0.4]  # [ResNet50, ConvNeXt-Tiny]

# ============================================================================
# Model evaluation metrics — for the AI Dashboard page.
# These are NOT computed at runtime (that needs the held-out test set, which
# lives with the training notebook, not this app). Fill them in yourself
# from sklearn.metrics.classification_report(y_true, y_pred) run on your
# test split in Plant_Training_25Classes.ipynb, then leave them here.
# Leave a value as None until you have the real number — the dashboard
# will show "not computed yet" instead of a made-up figure.
# ============================================================================
MODEL_METRICS = {
    "test_accuracy": 97.05,        # ensemble, evaluated on the cleaned 25-class test set
    "precision_macro": 0.98,
    "recall_macro": 0.98,
    "f1_macro": 0.98,
    "num_training_images": None,  # e.g. 3400 — total images used for training, if you want it shown
}

IMG_SIZE = 224

# Confidence handling — two tiers.
# Below UNKNOWN_THRESHOLD: probably not one of our 25 plants at all.
# Below LOW_CONF_THRESHOLD: probably one of our plants, but not sure enough to state it plainly.
UNKNOWN_THRESHOLD  = float(os.environ.get("UNKNOWN_THRESHOLD", 0.35))
LOW_CONF_THRESHOLD = float(os.environ.get("LOW_CONF_THRESHOLD", 0.55))

# Softmax temperature to soften over-confident logits (T > 1 = less confident).
# The notebook currently doesn't fit this against a held-out set — 1.5 is a
# reasonable starting point. Tune it properly with Temperature Scaling on the
# validation set if you have time (see the improvements list you were sent).
SOFTMAX_TEMPERATURE = float(os.environ.get("SOFTMAX_TEMPERATURE", 1.0))

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}
MAX_CONTENT_LENGTH_MB = 8

PLANTS_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plants.json")
LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prediction_log.csv")

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


# ============================================================================
# Model definitions — must match the training notebook exactly
# ============================================================================

def build_resnet50(n):
    m = resnet50(weights=None)
    m.fc = nn.Sequential(nn.Dropout(0.3), nn.Linear(m.fc.in_features, n))
    return m


def build_convnext_tiny(n):
    m = convnext_tiny(weights=None)
    in_f = m.classifier[2].in_features
    m.classifier[2] = nn.Linear(in_f, n)
    return m


# ============================================================================
# Load class names + models ONCE at startup (this is the "Cache Models" fix —
# nothing here happens inside a request handler).
# ============================================================================

def load_class_names():
    if not os.path.exists(CLASS_NAMES_FILE):
        raise FileNotFoundError(
            f"Class names file not found at {CLASS_NAMES_FILE}. "
            "Run the final cell of the training notebook first — it saves this file."
        )
    with open(CLASS_NAMES_FILE, "r", encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip()]


def load_model(build_fn, ckpt_path, num_classes):
    if not os.path.exists(ckpt_path):
        raise FileNotFoundError(
            f"Checkpoint not found at {ckpt_path}. "
            "Make sure the training notebook has finished training this model."
        )
    model = build_fn(num_classes)
    model.load_state_dict(torch.load(ckpt_path, map_location=device))
    model.to(device)
    model.eval()
    return model


print("Loading class names and models — this happens once at startup...")
CLASS_NAMES = load_class_names()
NUM_CLASSES = len(CLASS_NAMES)

model_resnet = load_model(build_resnet50, RESNET_CKPT, NUM_CLASSES)
model_convnext = load_model(build_convnext_tiny, CONVNEXT_CKPT, NUM_CLASSES)
print(f"Ready. {NUM_CLASSES} classes, device={device}.")

# ============================================================================
# Out-of-distribution check ("this doesn't look like any of our 25 plants
# at all", e.g. a screenshot or random object) — via nearest-centroid
# distance in ResNet50's feature space, NOT a 3rd model. Product decision
# (2026-07-26): a raw softmax confidence can't tell "not a plant" apart
# from "an unfamiliar plant" (the 25-way head always sums to 100% no
# matter what image goes in), so this adds a genuinely separate signal
# using features we already compute during the normal forward pass.
#
# class_centroids.json is produced OFFLINE by
# scripts/compute_class_centroids.py (run once in the training environment,
# where the actual training images live) and copied next to the .pth
# checkpoints. If it's missing, this check is silently disabled and
# behavior falls back to the confidence-only logic exactly as before —
# it never blocks the app from starting.
# ============================================================================
CENTROIDS_FILE = os.path.join(MODELS_DIR, "class_centroids.json")
CLASS_CENTROIDS = None
OOD_THRESHOLD = None
_resnet_features = {}


def _capture_resnet_features(module, inp, out):
    _resnet_features["feat"] = out.detach()


if os.path.exists(CENTROIDS_FILE):
    try:
        with open(CENTROIDS_FILE, "r", encoding="utf-8") as f:
            _centroid_data = json.load(f)
        if _centroid_data.get("class_names") != CLASS_NAMES:
            print("⚠️  class_centroids.json class order doesn't match class_names_25.txt — "
                  "OOD check disabled to avoid comparing against the wrong classes.")
        else:
            CLASS_CENTROIDS = np.array(_centroid_data["centroids"], dtype=np.float32)
            OOD_THRESHOLD = float(_centroid_data["threshold"])
            model_resnet.avgpool.register_forward_hook(_capture_resnet_features)
            print(f"OOD check enabled (distance threshold = {OOD_THRESHOLD:.2f}).")
    except Exception as e:
        print(f"⚠️  Could not load class_centroids.json ({e}) — OOD check disabled.")
else:
    print("ℹ️  class_centroids.json not found — OOD check disabled "
          "(run scripts/compute_class_centroids.py once to enable it).")


# ============================================================================
# Preprocessing — must match val_tf in the training notebook
# ============================================================================

preprocess = transforms.Compose([
    transforms.Resize((IMG_SIZE, IMG_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ============================================================================
# Core prediction logic
# ============================================================================

def predict_image(pil_image):
    """Runs the ResNet50 + ConvNeXt-Tiny ensemble on a single PIL image.
    Returns a dict with the top-5 predictions and a status flag."""
    tensor = preprocess(pil_image.convert("RGB")).unsqueeze(0).to(device)

    t0 = time.time()
    with torch.no_grad():
        logits_rn = model_resnet(tensor) / SOFTMAX_TEMPERATURE
        logits_cx = model_convnext(tensor) / SOFTMAX_TEMPERATURE
        probs_rn = softmax(logits_rn, dim=1)
        probs_cx = softmax(logits_cx, dim=1)
        probs = ENSEMBLE_WEIGHTS[0] * probs_rn + ENSEMBLE_WEIGHTS[1] * probs_cx
        probs = probs.squeeze(0).cpu()
    inference_ms = (time.time() - t0) * 1000

    # Nearest-centroid distance check (feature-space OOD detection) — uses
    # the ResNet50 penultimate features captured by the forward hook above
    # during the SAME forward pass, so this adds no extra inference cost.
    # Only runs at all if class_centroids.json loaded successfully at startup.
    ood_distance = None
    is_out_of_distribution = False
    if CLASS_CENTROIDS is not None and "feat" in _resnet_features:
        feat = _resnet_features["feat"].flatten(1).cpu().numpy()[0]  # (2048,)
        dists = np.linalg.norm(CLASS_CENTROIDS - feat, axis=1)
        ood_distance = float(dists.min())
        is_out_of_distribution = ood_distance > OOD_THRESHOLD

    top3_probs, top3_idx = torch.topk(probs, k=min(5, NUM_CLASSES))
    top3 = [
        {"name": CLASS_NAMES[i], "confidence": round(float(p) * 100, 2)}
        for p, i in zip(top3_probs, top3_idx)
    ]

    top1_conf = top3[0]["confidence"] / 100.0
    if is_out_of_distribution:
        # Doesn't resemble ANY of the 25 plants' feature patterns closely
        # enough — likely not a plant photo at all (screenshot, object,
        # document, ...), regardless of what the softmax confidence says.
        status = "not_a_plant"
    elif top3[0]["name"] == "Other":
        # The model's own 26th class (trained explicitly on non-plant /
        # unrelated-plant images) is the top guess — this is a direct,
        # learned "not one of our 25 species" verdict, distinct from the
        # feature-distance heuristic above. Route it the same way as
        # "unknown" so plants.json lookups never see "Other" as a name.
        status = "unknown"
    elif top1_conf < UNKNOWN_THRESHOLD:
        status = "unknown"
    elif top1_conf < LOW_CONF_THRESHOLD:
        status = "low_confidence"
    else:
        status = "ok"

    # When we're confidently saying "this isn't one of our 25 plants", show
    # THAT as a high number instead of the raw (low, confusing-looking) top1
    # class probability. This is the complement of top1_conf (1 - top1_conf)
    # -- a simple, honest reframing of the SAME softmax output we already
    # compute, not a new detection capability on its own. For "not_a_plant"
    # specifically, the feature-distance check IS the real new signal —
    # this percentage there is just for a consistent display, not the basis
    # of that particular verdict.
    #
    # EXCEPTION: when the model's own top pick IS the "Other" class, its
    # confidence already directly answers "how sure are we this isn't one
    # of the 25?" — inverting it would take a *confident* Other verdict
    # (e.g. 91%) and wrongly display it as a *low* number (9%), which is
    # backwards and confusing. Only invert for the old-style case: low,
    # spread-out top1 confidence with no single class (Other included)
    # standing out.
    if status == "unknown" and top3[0]["name"] == "Other":
        unrecognized_confidence = top3[0]["confidence"]
    else:
        unrecognized_confidence = round((1 - top1_conf) * 100, 2) if status in ("unknown", "not_a_plant") else None

    return {
        "status": status,
        "top3": top3,
        "prediction": top3[0]["name"] if status == "ok" else None,
        "confidence": top3[0]["confidence"],
        "unrecognized_confidence": unrecognized_confidence,
        "ood_distance": round(ood_distance, 2) if ood_distance is not None else None,
        "inference_time_ms": round(inference_ms, 2),
        "top1_idx": int(top3_idx[0]),
    }


# ============================================================================
# Grad-CAM — real attention map, computed from ResNet50's last conv block
# (layer4). This is the classic Grad-CAM recipe (Selvaraju et al., 2017):
# hook the target layer's activations and gradients, weight each channel by
# the average gradient flowing into it, and combine into a single heatmap.
# We only run this on ResNet50 — it's the model this technique was designed
# for and validated on. Running the same hook-based recipe on ConvNeXt would
# be visualizing a different kind of layer (a LayerNorm'd conv stage) without
# the same validation behind it, so we don't present that as equivalent.
# ============================================================================

_gradcam_activations = {}
_gradcam_gradients = {}


def _gradcam_forward_hook(module, inp, out):
    _gradcam_activations["value"] = out


def _gradcam_backward_hook(module, grad_in, grad_out):
    _gradcam_gradients["value"] = grad_out[0]


def _jet_colormap(x):
    """Maps a 2D array in [0, 1] to an RGB uint8 array using a jet-like ramp
    (blue -> cyan -> green -> yellow -> red), without needing matplotlib."""
    x = np.clip(x, 0.0, 1.0)
    r = np.clip(1.5 - np.abs(4 * x - 3), 0, 1)
    g = np.clip(1.5 - np.abs(4 * x - 2), 0, 1)
    b = np.clip(1.5 - np.abs(4 * x - 1), 0, 1)
    return np.stack([r, g, b], axis=-1)


def generate_gradcam(pil_image, target_idx):
    """Returns (original_224_rgb_uint8, overlay_rgb_uint8) as numpy arrays."""
    tensor = preprocess(pil_image.convert("RGB")).unsqueeze(0).to(device)
    tensor.requires_grad_(True)

    target_layer = model_resnet.layer4
    fh = target_layer.register_forward_hook(_gradcam_forward_hook)
    bh = target_layer.register_full_backward_hook(_gradcam_backward_hook)

    try:
        model_resnet.zero_grad()
        was_training = model_resnet.training
        model_resnet.eval()

        logits = model_resnet(tensor)
        score = logits[0, target_idx]
        score.backward()

        activations = _gradcam_activations["value"][0]   # (C, H, W)
        gradients = _gradcam_gradients["value"][0]        # (C, H, W)

        weights = gradients.mean(dim=(1, 2))               # (C,)
        cam = torch.relu((weights[:, None, None] * activations).sum(dim=0))  # (H, W)
        cam = cam.detach().cpu().numpy()
        cam = cam - cam.min()
        if cam.max() > 1e-8:
            cam = cam / cam.max()

        if was_training:
            model_resnet.train()
    finally:
        fh.remove()
        bh.remove()

    cam_img = Image.fromarray((cam * 255).astype(np.uint8)).resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
    cam_resized = np.asarray(cam_img).astype(np.float32) / 255.0

    heat_rgb = (_jet_colormap(cam_resized) * 255).astype(np.uint8)

    base_img = pil_image.convert("RGB").resize((IMG_SIZE, IMG_SIZE))
    base_arr = np.asarray(base_img).astype(np.float32)

    alpha = 0.45
    overlay = (1 - alpha) * base_arr + alpha * heat_rgb.astype(np.float32)
    overlay = np.clip(overlay, 0, 255).astype(np.uint8)

    return base_arr.astype(np.uint8), overlay


def array_to_data_url(arr):
    img = Image.fromarray(arr)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


# ============================================================================
# Plants database (optional lookup info)
# ============================================================================

def load_plants_db():
    if os.path.exists(PLANTS_JSON):
        with open(PLANTS_JSON, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


PLANTS_DB = load_plants_db()


# ============================================================================
# Chatbot — simple keyword matching against our own verified plants.json.
# No external LLM/API: matches an EN/AR keyword to a field, returns that
# field from the plant's record. Content itself (uses/warnings/description)
# is stored in English only in plants.json — we don't have verified Arabic
# translations of that text, so replies use the Arabic plant name but the
# factual content stays in English rather than us inventing a translation.
# ============================================================================

CHAT_KEYWORDS = {
    # English
    "use": "uses", "uses": "uses", "benefit": "uses", "benefits": "uses",
    "treat": "uses", "medicinal": "uses",
    "recipe": "recipe", "prepare": "recipe", "preparation": "recipe",
    "brew": "recipe", "how to make": "recipe",
    "warn": "warnings", "warning": "warnings", "warnings": "warnings",
    "danger": "warnings", "side effect": "warnings", "safe": "toxic_status",
    "toxic": "toxic_status", "poison": "toxic_status", "poisonous": "toxic_status",
    "dangerous": "toxic_status",
    "scientific": "scientific", "latin": "scientific", "species": "scientific",
    "arabic": "arabic_name", "english": "english_name", "name": "english_name",
    "family": "family",
    "habitat": "habitat", "where": "habitat", "location": "habitat", "native": "habitat",
    "grow": "growing", "cultivat": "growing",
    "compound": "compounds", "compounds": "compounds", "chemical": "compounds",
    "describe": "description", "description": "description", "what is": "description",
    # Arabic
    "فوائد": "uses", "استخدام": "uses", "استخدامات": "uses", "علاج": "uses",
    "تحضير": "recipe", "وصفة": "recipe", "اسوي": "recipe", "اعمل شاي": "recipe",
    "تحذير": "warnings", "خطر": "warnings", "ضار": "warnings", "آثار": "warnings",
    "سام": "toxic_status", "سامة": "toxic_status", "آمن": "toxic_status", "مضر": "toxic_status",
    "علمي": "scientific", "اسم علمي": "scientific",
    "عربي": "arabic_name", "انجليزي": "english_name",
    "فصيلة": "family", "عائلة": "family",
    "موطن": "habitat", "انتشار": "habitat", "بلد": "habitat",
    "يزرع": "growing", "زراعة": "growing", "ينمو": "growing",
    "مركبات": "compounds", "وصف": "description",
}

CHAT_FORBIDDEN = ["<script", "javascript:", "drop ", "union ", "--", "{{", "${"]

# Bilingual header shown above a *focused* answer (see get_focused_field).
# Product decision (2026-07-26): asking about ONE thing (e.g. "فوائد
# النعناع") should answer ONLY that thing -- no bundled description,
# warnings, recipe, etc. and no "show more" button at all.
FIELD_LABELS = {
    "uses": {"ar": "الاستخدامات والفوائد", "en": "Uses & Benefits"},
    "recipe": {"ar": "طريقة التحضير", "en": "How to Prepare"},
    "warnings": {"ar": "التحذيرات", "en": "Warnings"},
    "toxic_status": {"ar": "درجة السمّية", "en": "Toxicity"},
    "scientific": {"ar": "الاسم العلمي", "en": "Scientific Name"},
    "arabic_name": {"ar": "الاسم بالعربي", "en": "Arabic Name"},
    "english_name": {"ar": "الاسم بالإنجليزي", "en": "English Name"},
    "family": {"ar": "الفصيلة", "en": "Family"},
    "habitat": {"ar": "الموطن الأصلي", "en": "Habitat"},
    "growing": {"ar": "طريقة الزراعة والعناية", "en": "Growing & Care"},
    "compounds": {"ar": "المركبات الفعالة", "en": "Active Compounds"},
    "description": {"ar": "الوصف", "en": "Description"},
}

# Short natural-language phrase that reliably re-triggers each field via
# CHAT_KEYWORDS above -- used to build the "related" follow-up buttons
# under a focused answer (progressive disclosure, no need to retype).
FIELD_QUICK_QUERY = {
    "uses": {"ar": "الفوائد", "en": "benefits"},
    "recipe": {"ar": "طريقة التحضير", "en": "how to prepare it"},
    "warnings": {"ar": "التحذيرات", "en": "warnings"},
    "growing": {"ar": "طريقة الزراعة", "en": "how is it grown"},
    "toxic_status": {"ar": "هل هو سام؟", "en": "is it toxic"},
    "scientific": {"ar": "الاسم العلمي", "en": "scientific name"},
    "arabic_name": {"ar": "الاسم بالعربي", "en": "arabic name"},
    "english_name": {"ar": "الاسم بالإنجليزي", "en": "english name"},
    "family": {"ar": "الفصيلة", "en": "family"},
    "habitat": {"ar": "الموطن الأصلي", "en": "habitat"},
    "compounds": {"ar": "المركبات الفعالة", "en": "active compounds"},
    "description": {"ar": "الوصف", "en": "description"},
}

# Which OTHER fields to offer as quick follow-up buttons after a focused
# answer -- capped at 3 (product decision: keep it short, not cluttered).
RELATED_FIELDS = {
    "uses": ["recipe", "warnings", "growing"],
    "recipe": ["warnings", "growing", "uses"],
    "warnings": ["uses", "recipe"],
    "growing": ["uses", "warnings"],
    "toxic_status": ["warnings", "uses"],
    "scientific": ["uses", "habitat"],
    "arabic_name": ["uses", "scientific"],
    "english_name": ["uses", "scientific"],
    "family": ["scientific", "habitat"],
    "habitat": ["growing", "uses"],
    "compounds": ["uses", "warnings"],
    "description": ["uses", "recipe", "warnings"],
}

TOXIC_STATUS_TEXT = {
    "safe": {"ar": "آمن للاستخدام ضمن الجرعات المعروفة", "en": "Safe within known common doses"},
    "low_toxic": {"ar": "سمّيته منخفضة — يُستخدم بحذر", "en": "Mildly toxic — use with caution"},
    "dangerous": {"ar": "سام / خطير", "en": "Poisonous / dangerous"},
    "highly_toxic": {"ar": "شديد السمّية", "en": "Highly toxic"},
    "unknown": {"ar": "درجة سمّيته غير معروفة بدقة", "en": "Toxicity level not precisely known"},
}

# Random "storytelling" flourish shown before some answers (product
# decision 2026-07-26: appear randomly on MOST answers, not a fixed
# field/message type). Built from the plant's OWN verified uses/
# description text -- never an invented historical claim -- just a
# different narrative wrapper around real data.
STORY_TEMPLATES = {
    "ar": [
        "🕰️ من قديم الزمان: {snippet}",
        "منذ آلاف السنين، ارتبط اسم {name} بهذا: {snippet}",
        "حكاية قديمة عن {name} — {snippet}",
        "يُحكى أن الأجداد عرفوا {name} من أجل هذا: {snippet}",
        "منذ الأزل، و{name} جزء من الطب الشعبي: {snippet}",
    ],
    "en": [
        "🕰️ A story from long ago: {snippet}",
        "For thousands of years, {name} has carried this reputation: {snippet}",
        "An old tale about {name} — {snippet}",
        "Long before modern medicine, people already knew: {snippet}",
        "Since ancient times, {name} has been part of folk medicine: {snippet}",
    ],
}

STORY_CHANCE = 0.65  # "most answers", per product decision -- not all.


def find_target_plant(message, current_plant=None):
    msg_lower = message.lower()
    for cls in CLASS_NAMES:
        info = PLANTS_DB.get(cls, {})
        candidates = [cls.lower(), (info.get("english_name") or "").lower(),
                      (info.get("scientific_name") or "").lower()]
        arabic = info.get("arabic_name") or ""
        if any(c and c in msg_lower for c in candidates) or (arabic and arabic in message):
            return cls
    if current_plant in CLASS_NAMES:
        return current_plant
    return None


_ARABIC_RE = re.compile(r"[\u0600-\u06FF]")


def detect_lang(text):
    """Very small heuristic: if the message has any Arabic-script
    characters, answer in Arabic; otherwise answer in English."""
    return "ar" if _ARABIC_RE.search(text or "") else "en"


def format_sources(info):
    """Wikipedia link only (per project decision) — a fixed, vetted
    reference instead of an open web search."""
    ar_refs = info.get("reference_ar") or []
    return ar_refs[0] if ar_refs else None


# Free-text mood/feeling phrases -> mood key. Mirrors MOOD_PLANTS in
# script.js by hand (keep both in sync if you add a mood there).
MOOD_TRIGGERS = {
    "calm": ["متوتر", "توتر", "قلق", "عصبي", "مضغوط", "stressed", "anxious", "nervous", "overwhelmed"],
    "anger": ["غضبان", "غاضب", "زعلان", "منفعل", "angry", "mad", "furious", "irritated"],
    "energy": ["تعبان", "مرهق", "تعب", "خمول", "tired", "fatigue", "fatigued", "exhausted", "sluggish"],
    "digestion": ["معدتي", "بطني", "هضم", "غثيان", "انتفاخ", "stomach", "nausea", "bloated", "indigestion"],
    "immune": ["مريض", "برد", "رشح", "سعال", "زكام", "sick", "cold", "cough", "flu"],
    "sleep": ["أرق", "مانمت", "ما بنام", "مو قادرة انام", "insomnia", "can't sleep", "cant sleep"],
}

MOOD_PLANTS = {
    "calm": ["khuzama_lavender", "chamomile", "tulsi"],
    "anger": ["khuzama_lavender", "chamomile", "tulsi"],
    "energy": ["centella", "sage"],
    "digestion": ["Mint", "Za'atar", "bohera", "chamomile", "haritoki", "phyllanthus", "rosemary", "sage", "thankuni", "zanjabeel_ginger", "Lemon"],
    "immune": ["Justicia", "Lemon", "Za'atar", "tulsi", "phyllanthus"],
    "sleep": ["chamomile", "khuzama_lavender"],
}


def detect_mood(message):
    msg_lower = message.lower()
    for mood, phrases in MOOD_TRIGGERS.items():
        if any(p in msg_lower or p in message for p in phrases):
            return mood
    return None


def plant_card(key, lang, focus_field=None):
    """Builds the full structured payload the chat UI renders as a rich
    card for one plant — same shape whether it's the main answer or one
    of a mood suggestion's entries."""
    info = PLANTS_DB.get(key)
    if not info:
        return None
    arabic = info.get("arabic_name") or key
    english = info.get("english_name") or key
    return {
        "plant_key": key,
        "name": (arabic if lang == "ar" and info.get("arabic_name") else english),
        "scientific_name": info.get("scientific_name"),
        "family": (info.get("family_ar") if lang == "ar" and info.get("family_ar") else info.get("family")),
        "toxicity_level": info.get("toxicity_level") or "unknown",
        "medicinal": bool(info.get("medicinal")),
        "poisonous": bool(info.get("poisonous")),
        "image_url": info.get("image_url"),
        "description": (info.get("description_ar") if lang == "ar" and info.get("description_ar") else info.get("description")),
        "uses": (info.get("uses_ar") if lang == "ar" and info.get("uses_ar") else info.get("uses")) or [],
        "warnings": (info.get("warnings_ar") if lang == "ar" and info.get("warnings_ar") else info.get("warnings")),
        "habitat": (info.get("habitat_ar") if lang == "ar" and info.get("habitat_ar") else info.get("habitat")),
        "growing_method": (info.get("growing_method_ar") if lang == "ar" and info.get("growing_method_ar") else info.get("growing_method")),
        "prep": (info.get("safe_dosage_ar") if lang == "ar" and info.get("safe_dosage_ar") else info.get("safe_dosage")),
        "source_url": format_sources(info),
        "focus_field": focus_field,
    }


def get_focused_field(info, field, lang):
    """Extract JUST the one field the user actually asked about, for a
    short focused chat answer -- no bundled description/warnings/recipe
    like the full plant_card() gives. Returns {label, content, content_type}
    where content_type is 'list' or 'text' (frontend renders accordingly,
    with its own i18n fallback text for an empty/missing value)."""
    label = FIELD_LABELS.get(field, {}).get(lang, field)

    if field == "uses":
        items = (info.get("uses_ar") if lang == "ar" and info.get("uses_ar") else info.get("uses")) or []
        return {"label": label, "content": items, "content_type": "list"}

    if field == "compounds":
        items = info.get("active_compounds") or []
        return {"label": label, "content": items, "content_type": "list"}

    if field == "recipe":
        recipes = info.get("recipes") or []
        if not recipes:
            return {"label": label, "content": None, "content_type": "recipe"}
        r = recipes[0]
        if lang == "ar":
            ingredients = r.get("ingredients_ar") or r.get("ingredients") or []
            steps = r.get("steps_ar") or r.get("steps") or []
            benefits = r.get("benefits_ar") or r.get("benefits") or []
            title = r.get("title_ar") or r.get("title") or ""
        else:
            ingredients = r.get("ingredients") or []
            steps = r.get("steps") or []
            benefits = r.get("benefits") or []
            title = r.get("title") or ""
        return {
            "label": label,
            "content": {
                "title": title,
                "ingredients": ingredients,
                "steps": steps,
                "tip": benefits[0] if benefits else None,
            },
            "content_type": "recipe",
        }

    if field == "growing":
        method = (info.get("growing_method_ar") if lang == "ar" and info.get("growing_method_ar") else info.get("growing_method")) or ""
        care = (info.get("care_ar") if lang == "ar" and info.get("care_ar") else info.get("care")) or ""
        if not method and not care:
            return {"label": label, "content": None, "content_type": "growing"}
        return {"label": label, "content": {"method": method, "care": care}, "content_type": "growing"}

    if field == "warnings":
        text = (info.get("warnings_ar") if lang == "ar" and info.get("warnings_ar") else info.get("warnings")) or ""
        return {"label": label, "content": text, "content_type": "text"}

    if field == "toxic_status":
        level = info.get("toxicity_level") or "unknown"
        text = TOXIC_STATUS_TEXT.get(level, TOXIC_STATUS_TEXT["unknown"]).get(lang)
        return {"label": label, "content": text, "content_type": "text"}

    if field == "scientific":
        return {"label": label, "content": info.get("scientific_name") or "", "content_type": "text"}

    if field == "arabic_name":
        return {"label": label, "content": info.get("arabic_name") or "", "content_type": "text"}

    if field == "english_name":
        return {"label": label, "content": info.get("english_name") or "", "content_type": "text"}

    if field == "family":
        text = (info.get("family_ar") if lang == "ar" and info.get("family_ar") else info.get("family")) or ""
        return {"label": label, "content": text, "content_type": "text"}

    if field == "habitat":
        text = (info.get("habitat_ar") if lang == "ar" and info.get("habitat_ar") else info.get("habitat")) or ""
        return {"label": label, "content": text, "content_type": "text"}

    if field == "description":
        text = (info.get("description_ar") if lang == "ar" and info.get("description_ar") else info.get("description")) or ""
        return {"label": label, "content": text, "content_type": "text"}

    return {"label": label, "content": "", "content_type": "text"}


def build_story_intro(info, name, lang):
    """Occasionally return a short 'storytelling' flourish line to show
    before an answer -- built from the plant's OWN verified uses/
    description text (never an invented fact), just phrased as a little
    piece of folklore. Returns None most of the time by design, and
    also whenever there's no real content to build the sentence from."""
    if random.random() > STORY_CHANCE:
        return None

    uses_list = (info.get("uses_ar") if lang == "ar" else None) or info.get("uses") or []
    snippet = random.choice(uses_list) if uses_list else None
    if not snippet:
        snippet = (info.get("description_ar") if lang == "ar" else None) or info.get("description")
    if not snippet:
        return None

    template = random.choice(STORY_TEMPLATES.get(lang, STORY_TEMPLATES["en"]))
    return template.format(name=name, snippet=snippet)


def build_related_actions(field, lang):
    """3 small follow-up buttons under a focused answer, so the person
    can expand into a related field (e.g. warnings/growing) without
    retyping a question -- product decision (2026-07-26)."""
    fields = RELATED_FIELDS.get(field, ["uses", "warnings"])
    actions = []
    for f in fields:
        query = FIELD_QUICK_QUERY.get(f, {}).get(lang)
        lbl = FIELD_LABELS.get(f, {}).get(lang, f)
        if query:
            actions.append({"field": f, "label": lbl, "query": query})
    return actions


def chatbot_reply(message, current_plant=None):
    lang = detect_lang(message)

    if not message or not message.strip():
        return {"type": "empty", "lang": lang}

    if any(f in message.lower() for f in CHAT_FORBIDDEN):
        return {"type": "forbidden", "lang": lang}

    mood = detect_mood(message)
    if mood:
        plants = [plant_card(k, lang) for k in MOOD_PLANTS.get(mood, [])]
        plants = [p for p in plants if p]
        return {"type": "mood", "lang": lang, "mood": mood, "plants": plants}

    target = find_target_plant(message, current_plant)
    if not target:
        return {"type": "not_found", "lang": lang}

    info = PLANTS_DB.get(target)
    if not info:
        return {"type": "not_found", "lang": lang}

    field = None
    for kw, f in CHAT_KEYWORDS.items():
        if kw in message.lower():
            field = f
            break

    name = (info.get("arabic_name") if lang == "ar" and info.get("arabic_name") else info.get("english_name")) or target

    # Asked about ONE specific thing (e.g. "فوائد النعناع") -> answer ONLY
    # that, nothing bundled in. Product decision (2026-07-26): no extra
    # "show full details" button either -- just the requested part.
    if field:
        focused = get_focused_field(info, field, lang)
        return {
            "type": "plant_focused",
            "lang": lang,
            "plant_key": target,
            "name": name,
            "field": field,
            "field_label": focused["label"],
            "content": focused["content"],
            "content_type": focused["content_type"],
            # Story intro is reserved for general "tell me about X"
            # questions only (product decision 2026-07-26), not here.
            "story_intro": None,
            "related_actions": build_related_actions(field, lang),
        }

    # General question about the plant (no specific field detected) ->
    # the full profile card, same as before.
    card = plant_card(target, lang)
    if not card:
        return {"type": "not_found", "lang": lang}
    return {"type": "plant", "lang": lang, "story_intro": build_story_intro(info, name, lang), **card}


# ============================================================================
# Logging
# ============================================================================

def log_prediction(filename, result):
    file_exists = os.path.exists(LOG_FILE)
    with open(LOG_FILE, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow(["timestamp", "filename", "status", "prediction", "confidence", "inference_time_ms"])
        writer.writerow([
            datetime.datetime.now().isoformat(timespec="seconds"),
            filename,
            result["status"],
            result["prediction"],
            result["confidence"],
            result["inference_time_ms"],
        ])


# ============================================================================
# Flask app
# ============================================================================

app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH_MB * 1024 * 1024


@app.route("/", methods=["GET"])
def index():
    """Main app screen — upload, AI analysis, prediction, Grad-CAM, plant info."""
    return render_template("index.html")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "device": str(device),
        "num_classes": NUM_CLASSES,
        "ensemble_weights": {"ResNet50": ENSEMBLE_WEIGHTS[0], "ConvNeXt-Tiny": ENSEMBLE_WEIGHTS[1]},
    })


@app.route("/predict", methods=["POST"])
def predict():
    if "image" not in request.files:
        return jsonify({"error": "No file uploaded. Send the image under the 'image' field."}), 400

    file = request.files["image"]

    if file.filename == "":
        return jsonify({"error": "Empty filename."}), 400

    try:
        image_bytes = file.read()
        pil_image = Image.open(io.BytesIO(image_bytes))
        pil_image.verify()  # checks the file isn't corrupted
        pil_image = Image.open(io.BytesIO(image_bytes))  # re-open, verify() consumes the file pointer
    except UnidentifiedImageError:
        return jsonify({"error": "This doesn't look like a valid image file."}), 400
    except Exception:
        return jsonify({"error": "Could not read the uploaded image."}), 400

    try:
        result = predict_image(pil_image)
    except Exception as e:
        app.logger.exception("Prediction failed")
        return jsonify({"error": "Something went wrong while running the model.", "detail": str(e)}), 500

    log_prediction(file.filename, result)

    # NOTE: the web frontend no longer reads this field — it derives its own
    # localized (AR/EN) message from `status` via i18n.js instead, so this
    # message never accidentally shows up in English on an Arabic screen.
    # Left here only for anyone hitting /predict directly (API consumers).
    if result["status"] == "not_a_plant":
        result["message"] = "This doesn't look like a plant photo at all — none of the 25 known plants' visual patterns match it closely."
    elif result["status"] == "unknown":
        result["message"] = "Unknown plant — this doesn't look like it's in the current 25 classes."
    elif result["status"] == "low_confidence":
        result["message"] = "Low confidence — please take another, clearer photo."
    else:
        result["message"] = None

    result["info"] = PLANTS_DB.get(result["prediction"]) if result["prediction"] else None

    for entry in result.get("top3", []):
        p = PLANTS_DB.get(entry["name"])
        entry["display_en"] = (p.get("english_name") if p else None) or entry["name"]
        entry["display_ar"] = (p.get("arabic_name") if p else None) or (p.get("scientific_name") if p else None) or entry["display_en"]

    if result["status"] not in ("unknown", "not_a_plant"):
        try:
            _, overlay_arr = generate_gradcam(pil_image, result["top1_idx"])
            result["gradcam"] = {
                "overlay": array_to_data_url(overlay_arr),
                "model": "ResNet50 (layer4)",
            }
        except Exception:
            app.logger.exception("Grad-CAM failed")
            result["gradcam"] = None
    else:
        result["gradcam"] = None

    del result["top1_idx"]

    return jsonify(result)


@app.route("/plants", methods=["GET"])
def list_plants():
    return jsonify({
        "classes": CLASS_NAMES,
        "details_available_for": [k for k in PLANTS_DB.keys() if not k.startswith("_")],
    })


@app.route("/plants-all", methods=["GET"])
def all_plant_details():
    """Full details for every species that has an entry in plants.json —
    used by the Encyclopedia, Compare, Mood Match, and Herbarium pages.
    Includes 'reference'/'reference_ar' so Compare can cite sources."""
    out = []
    for key, info in PLANTS_DB.items():
        if key.startswith("_"):
            continue
        entry = {k: v for k, v in info.items()}
        entry["key"] = key
        out.append(entry)
    out.sort(key=lambda e: (e.get("english_name") or e.get("key") or "").lower())
    return jsonify({"plants": out})


@app.route("/plants/<name>", methods=["GET"])
def plant_details(name):
    info = PLANTS_DB.get(name)
    if info is None:
        return jsonify({"error": f"No details stored for '{name}' yet."}), 404
    return jsonify(info)


@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) or {}
    message = data.get("message", "")
    current_plant = data.get("current_plant")
    return jsonify(chatbot_reply(message, current_plant))


@app.route("/stats", methods=["GET"])
def stats():
    if not os.path.exists(LOG_FILE):
        return jsonify({"total_predictions": 0})

    total, low_conf, unknown, not_a_plant = 0, 0, 0, 0
    with open(LOG_FILE, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            if row["status"] == "low_confidence":
                low_conf += 1
            elif row["status"] == "unknown":
                unknown += 1
            elif row["status"] == "not_a_plant":
                not_a_plant += 1

    return jsonify({
        "total_predictions": total,
        "low_confidence": low_conf,
        "unknown": unknown,
        "not_a_plant": not_a_plant,
        "confident": total - low_conf - unknown - not_a_plant,
    })


@app.route("/dashboard-stats", methods=["GET"])
def dashboard_stats():
    total, low_conf, unknown, not_a_plant = 0, 0, 0, 0
    inference_times = []
    if os.path.exists(LOG_FILE):
        with open(LOG_FILE, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                total += 1
                if row["status"] == "low_confidence":
                    low_conf += 1
                elif row["status"] == "unknown":
                    unknown += 1
                elif row["status"] == "not_a_plant":
                    not_a_plant += 1
                try:
                    inference_times.append(float(row["inference_time_ms"]))
                except (KeyError, ValueError):
                    pass

    avg_inference_s = (sum(inference_times) / len(inference_times) / 1000) if inference_times else None

    non_readme = {k: v for k, v in PLANTS_DB.items() if not k.startswith("_")}
    num_toxic = sum(1 for v in non_readme.values() if v.get("toxicity_level") in ("dangerous", "highly_toxic"))
    num_medicinal = sum(1 for v in non_readme.values() if v.get("medicinal"))

    return jsonify({
        "total_predictions": total,
        "low_confidence": low_conf,
        "unknown": unknown,
        "not_a_plant": not_a_plant,
        "confident": total - low_conf - unknown - not_a_plant,
        "num_species": NUM_CLASSES,
        "num_documented_species": len(non_readme),
        "num_toxic_species": num_toxic,
        "num_medicinal_species": num_medicinal,
        "avg_inference_seconds": round(avg_inference_s, 2) if avg_inference_s is not None else None,
        "ensemble_weights": {"ResNet50": ENSEMBLE_WEIGHTS[0], "ConvNeXt-Tiny": ENSEMBLE_WEIGHTS[1]},
        "device": str(device),
        "metrics": MODEL_METRICS,
    })


@app.errorhandler(413)
def file_too_large(e):
    return jsonify({"error": f"Image is too large. Max size is {MAX_CONTENT_LENGTH_MB}MB."}), 413


@app.errorhandler(500)
def internal_error(e):
    return jsonify({"error": "Internal server error."}), 500


if __name__ == "__main__":
    # Local dev is unchanged (still port 5000, same as before). The
    # Dockerfile sets PORT=7860 explicitly for Hugging Face Spaces
    # (Docker SDK's default); other hosts (Render, Railway, ...) set
    # PORT themselves too, and this picks it up automatically either way.
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
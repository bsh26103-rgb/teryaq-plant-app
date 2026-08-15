FROM python:3.11-slim

# System libraries Pillow needs for JPEG/PNG handling.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libjpeg62-turbo-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces recommends running as a non-root user to avoid
# filesystem permission issues.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR $HOME/app

# Install PyTorch's CPU-only wheels FIRST and separately. The default
# PyPI build bundles CUDA support (multi-GB, slow to pull), which is
# wasted here since Spaces' free CPU tier has no GPU anyway — this app
# already runs on CPU locally too (see app.py: device = cuda if
# available else cpu).
RUN pip install --no-cache-dir --user torch torchvision \
        --index-url https://download.pytorch.org/whl/cpu

# Then the rest of the dependencies (torch/torchvision lines in this
# file are already satisfied by the step above, so pip just skips them).
COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# App code, templates, static assets, model checkpoints, plants.json —
# everything the app needs to run.
COPY --chown=user . .

# Hugging Face Spaces (Docker SDK) routes traffic to this port by default.
ENV PORT=7860
EXPOSE 7860

CMD ["python", "app.py"]

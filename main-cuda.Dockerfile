ARG UBUNTU_VERSION=22.04
ARG CUDA_VERSION=12.3.1
ARG BASE_CUDA_DEV_CONTAINER=nvidia/cuda:${CUDA_VERSION}-devel-ubuntu${UBUNTU_VERSION}
ARG BASE_CUDA_RUN_CONTAINER=nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${UBUNTU_VERSION}

# Ref: https://github.com/ggml-org/whisper.cpp
FROM ${BASE_CUDA_DEV_CONTAINER} AS install-whisper
ENV DEBIAN_FRONTEND=noninteractive
RUN apt update
# whisper install dependencies
RUN apt install -y \
    git \
    build-essential \
    wget \
    cmake \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /whisper
RUN git clone https://github.com/ggml-org/whisper.cpp.git .
RUN git checkout v1.7.5

ARG CUDA_DOCKER_ARCH=all
ENV CUDA_DOCKER_ARCH=${CUDA_DOCKER_ARCH}
ENV GGML_CUDA=1
# Ref: https://stackoverflow.com/a/53464012
ENV CUDA_MAIN_VERSION=12.3
ENV LD_LIBRARY_PATH=/usr/local/cuda-${CUDA_MAIN_VERSION}/compat:$LD_LIBRARY_PATH

RUN make
WORKDIR /whisper/models
RUN sh ./download-ggml-model.sh medium.en

FROM ${BASE_CUDA_RUN_CONTAINER} AS base
ENV CUDA_MAIN_VERSION=12.3
ENV LD_LIBRARY_PATH=/usr/local/cuda-${CUDA_MAIN_VERSION}/compat:$LD_LIBRARY_PATH

# install node
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN node -v && npm -v

# install dependencies
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app
RUN apt update
RUN apt install -y \
      # whisper dependencies
      git \
      wget \
      cmake \
      ffmpeg \
      curl \
      make \
      libsdl2-dev \
      # remotion dependencies
      libnss3 \
      libdbus-1-3 \
      libatk1.0-0 \
      libgbm-dev \
      libasound2 \
      libxrandr2 \
      libxkbcommon-dev \
      libxfixes3 \
      libxcomposite1 \
      libxdamage1 \
      libatk-bridge2.0-0 \
      libpango-1.0-0 \
      libcairo2 \
      libcups2 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
# setup pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml* /app/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile
RUN pnpm install --prefer-offline --no-cache --prod

FROM prod-deps AS build
COPY tsconfig.json /app
COPY src /app/src
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build

FROM base
COPY static /app/static
COPY --from=install-whisper /whisper /app/data/libs/whisper.cpp
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY package.json /app/

# app configuration via environment variables
ENV DATA_DIR_PATH=/app/data
ENV DOCKER=true

# install kokoro, headless chrome and ensure music files are present
RUN node dist/scripts/install.js

CMD ["pnpm", "start"]

# Build the viewer locally first, then compile Linux binaries in a Rust container:
# docker run --rm -v "$PWD:/work" -w /work rust:1.90-bookworm cargo build --locked --release
ARG BLIND_RUNTIME_BASE=debian:bookworm-slim
FROM ${BLIND_RUNTIME_BASE} AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-noto-cjk ca-certificates openssh-client libvulkan1 mesa-vulkan-drivers libegl1 libgl1 \
    && rm -rf /var/lib/apt/lists/*
FROM runtime-base
ARG BLIND_UID=1000
ARG BLIND_GID=1000
RUN groupadd --non-unique --gid "$BLIND_GID" blind \
    && useradd --uid "$BLIND_UID" --gid blind --no-create-home \
       --home-dir /config --shell /usr/sbin/nologin blind
ARG BLIND_BINARY=target/release/blind
COPY ${BLIND_BINARY} /usr/local/bin/blind
ENV BLIND_CONFIG_DIR=/config XDG_RUNTIME_DIR=/tmp WGPU_BACKEND=vulkan
USER blind
EXPOSE 7400
ENTRYPOINT ["/usr/local/bin/blind"]
CMD ["serve", "--listen", "0.0.0.0:7400"]

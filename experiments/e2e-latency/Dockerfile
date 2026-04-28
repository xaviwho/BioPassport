FROM minio/minio:latest AS minio-src

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends iproute2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=minio-src /usr/bin/minio /usr/bin/minio

ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]

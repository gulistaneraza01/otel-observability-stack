server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318

storage:
  trace:
    backend: s3
    s3:
      bucket: {{S3_BUCKET_TRACES}}
      endpoint: {{AWS_S3_ENDPOINT}}
      region: {{AWS_REGION}}
      access_key: {{AWS_ACCESS_KEY_ID}}
      secret_key: {{AWS_SECRET_ACCESS_KEY}}
      forcepathstyle: true
      insecure: false
    wal:
      path: /var/tempo/wal

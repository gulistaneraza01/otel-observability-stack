auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  replication_factor: 1
  ring:
    instance_addr: 127.0.0.1
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2026-01-01
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: index_
        period: 24h

storage_config:
  tsdb_shipper:
    active_index_directory: /loki/index
    cache_location: /loki/index_cache
  aws:
    bucketnames: {{S3_BUCKET_LOGS}}
    endpoint: https://{{AWS_S3_ENDPOINT}}
    region: {{AWS_REGION}}
    access_key_id: {{AWS_ACCESS_KEY_ID}}
    secret_access_key: {{AWS_SECRET_ACCESS_KEY}}
    s3forcepathstyle: true
    insecure: false

limits_config:
  allow_structured_metadata: true
  volume_enabled: true

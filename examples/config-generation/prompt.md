Generate a JSON service configuration object from the request below. The object must have exactly these keys:

- "name": the service name, lowercase letters, digits, and hyphens only
- "port": the TCP port as an integer
- "replicas": the replica count as an integer
- "log_level": one of "debug", "info", "warn", "error"

Return only the JSON object, no explanation and no markdown fences.

Request:

{{input}}

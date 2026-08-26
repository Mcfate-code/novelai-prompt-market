"""Optional remote related-tag adapter. Failures are intentionally empty."""
from __future__ import annotations

import json
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class RelatedClient:
    def __init__(self, url: str, timeout: float = 2.0):
        self.url, self.timeout = url, timeout

    def __call__(self, context):
        query = ",".join(context.tags)
        request = Request(f"{self.url}?{urlencode({'tags': query})}", headers={"Accept": "application/json"})
        try:
            with urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            return payload.get("results", payload.get("tags", payload if isinstance(payload, list) else []))
        except Exception:
            return []


__all__ = ["RelatedClient"]

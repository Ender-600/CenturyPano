"""Turn the text models' reasoning budget down, and survive models that lack it.

Scene parsing and the site historian are both structured-extraction calls against
a fixed schema: the model is not being asked to solve anything, it is being asked
to fill in fields. Gemini 3.x flash models think before answering by default,
which on these two calls buys little and costs seconds — and they sit one after
the other on the critical path before the first tile can start, so their latency
is the user's wait.

`thinkingLevel` is not accepted by every deployment, and a rejected parameter
comes back as HTTP 400, which the provider layer correctly treats as fatal and
does not retry. So the request is sent with the budget turned down and, if and
only if that exact request is rejected, sent once more without it. A model that
does not support the knob therefore costs one wasted round trip on the first
call, never a failed job.
"""
from __future__ import annotations

import copy

import httpx

from app.editors.base import ProviderError, check_response

THINKING_LEVEL = "low"


async def generate_content(url: str, headers: dict, payload: dict, provider: str, *,
                           timeout: float) -> dict:
    """POST a generateContent payload with reasoning minimised; return parsed JSON."""
    reduced = copy.deepcopy(payload)
    config = reduced.setdefault("generationConfig", {})
    config["thinkingConfig"] = {"thinkingLevel": THINKING_LEVEL}
    for attempt in (reduced, payload):
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, headers=headers, json=attempt)
        if response.status_code == 400 and attempt is reduced:
            continue  # This deployment does not accept the reasoning budget.
        check_response(response, provider)
        return response.json()
    raise ProviderError(f"{provider} rejected the request", provider=provider,
                        retryable=False, status=400, fatal=True)

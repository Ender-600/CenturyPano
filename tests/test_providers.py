import asyncio
import base64
import io
import json
from dataclasses import FrozenInstanceError, replace

import httpx
import pytest
from PIL import Image

from app import config, constraints, scene
from app.editors.base import EditorPool, ProviderError
from app.editors.demo import DemoEditor
from app.editors.fal import FalImg2ImgEditor
from app.editors.gemini import GeminiEditor
from app.editors.grok import GrokImagineEditor


def picture(size=(96, 48), color=(90, 135, 180)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, "JPEG")
    return output.getvalue()


def configured(monkeypatch, **kwargs):
    monkeypatch.setattr(config, "settings", replace(config.settings, **kwargs))


def test_gemini_sends_two_images_and_normalizes_output():
    source, reference = picture(), picture((24, 24))
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"inlineData": {
            "mimeType": "image/jpeg", "data": base64.b64encode(picture((32, 32))).decode(),
        }}]}}]})

    editor = GeminiEditor(api_key="test-only-key", transport=httpx.MockTransport(respond))
    output = asyncio.run(editor.edit(source, "One frozen prompt", reference=reference, negative="LED signs",
                                     structure_lock=True))
    payload = json.loads(requests[0].content)
    parts = payload["contents"][0]["parts"]
    assert len([part for part in parts if "inlineData" in part]) == 2
    assert parts[0]["text"] == "One frozen prompt"
    # The reference instruction shares a request with the structure policy, so it
    # must never license what that policy forbids.
    instruction = parts[2]["text"]
    assert "image 2" in instruction.lower() and "reference" in instruction.lower()
    for licence in ("remove or replace buildings", "recompose", "move the viewpoint"):
        assert f"but {licence}" not in instruction.lower()
    assert "do not add, remove, resize or replace any building" in instruction.lower()
    # With the pixel lock off, the reference instruction follows the composition
    # lock instead: masses stay put, historically justified change is allowed.
    asyncio.run(editor.edit(source, "One frozen prompt", reference=reference, negative="LED signs",
                            structure_lock=False))
    open_instruction = json.loads(requests[-1].content)["contents"][0]["parts"][2]["text"].lower()
    assert "major masses" in open_instruction and "historically justified" in open_instruction
    assert requests[0].headers["x-goog-api-key"] == "test-only-key"
    assert "test-only-key" not in str(requests[0].url)
    assert Image.open(io.BytesIO(output)).size == (96, 48)


def test_gemini_refusal_and_rate_limit_are_safe():
    def limited(request):
        return httpx.Response(429, json={"error": {"message": "secret-key-and-image-data"}})

    editor = GeminiEditor(api_key="test-key", transport=httpx.MockTransport(limited))
    with pytest.raises(ProviderError) as error:
        asyncio.run(editor.edit(picture(), "test"))
    assert error.value.rate_limited
    assert "secret" not in str(error.value)
    editor.transport = httpx.MockTransport(lambda _: httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}}))
    with pytest.raises(ProviderError) as error:
        asyncio.run(editor.edit(picture(), "test"))
    assert error.value.refusal


def test_fal_strength_seed_data_uri_and_safety():
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"images": [{"url": "data:image/jpeg;base64," + base64.b64encode(picture()).decode()}], "has_nsfw_concepts": [False]})

    editor = FalImg2ImgEditor(api_key="test-key", transport=httpx.MockTransport(respond))
    output = asyncio.run(editor.edit(picture(), "frozen prompt", seed=17, negative="LED"))
    payload = json.loads(requests[0].content)
    assert payload["strength"] == 0.45
    assert payload["seed"] == 17
    assert payload["image_url"].startswith("data:image/jpeg;base64,")
    assert payload["sync_mode"] is True
    assert payload["enable_safety_checker"] is True
    assert output.startswith(b"\xff\xd8")


def test_fal_will_not_fetch_untrusted_output_host():
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"images": [{"url": "https://localhost/private"}]})

    editor = FalImg2ImgEditor(api_key="test-key", transport=httpx.MockTransport(respond))
    with pytest.raises(ProviderError):
        asyncio.run(editor.edit(picture(), "frozen prompt"))
    assert len(requests) == 1


def test_grok_imagine_edits_with_base64_and_normalizes_output():
    source, reference = picture(), picture((24, 24))
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"data": [{
            "b64_json": base64.b64encode(picture((32, 32))).decode(),
        }]})

    editor = GrokImagineEditor(
        api_key="test-only-key", model="grok-imagine-image-2.0",
        transport=httpx.MockTransport(respond),
    )
    output = asyncio.run(editor.edit(source, "One frozen prompt", reference=reference, negative="LED signs"))
    payload = json.loads(requests[0].content)
    assert str(requests[0].url) == "https://api.x.ai/v1/images/edits"
    assert requests[0].headers["authorization"] == "Bearer test-only-key"
    assert payload["model"] == "grok-imagine-image-2.0"
    assert payload["response_format"] == "b64_json"
    assert len(payload["images"]) == 2
    assert payload["images"][0]["url"].startswith("data:image/jpeg;base64,")
    assert "Avoid these visual elements: LED signs" in payload["prompt"]
    assert "test-only-key" not in str(requests[0].url)
    assert Image.open(io.BytesIO(output)).size == (96, 48)


def test_grok_imagine_requires_xai_key():
    editor = GrokImagineEditor(api_key="", transport=httpx.MockTransport(lambda _: httpx.Response(500)))
    with pytest.raises(ProviderError) as error:
        asyncio.run(editor.edit(picture(), "test"))
    assert str(error.value) == "XAI_API_KEY is not configured"
    assert not error.value.retryable


class ScriptedEditor:
    def __init__(self, name, outcomes):
        self.name, self.outcomes, self.calls = name, list(outcomes), []

    async def edit(self, image, prompt, **kwargs):
        self.calls.append((image, prompt, kwargs))
        outcome = self.outcomes.pop(0) if self.outcomes else image
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def test_circuit_switches_current_and_remaining_tiles():
    async def run():
        primary = ScriptedEditor("gemini", [ProviderError("unavailable"), ProviderError("unavailable")])
        fallback = ScriptedEditor("fal", [picture(), picture()])
        pool = EditorPool(primary, fallback, backoff=())
        first = await pool.edit(picture(), "frozen prompt")
        second = await pool.edit(picture(), "frozen prompt")
        assert first.provider == second.provider == "fal"
        assert first.attempts == 3 and second.attempts == 1
        assert len(primary.calls) == 2 and pool.image_calls == 4
        assert pool.primary_open
    asyncio.run(run())


def test_content_refusal_retries_without_negative():
    async def run():
        primary = ScriptedEditor("gemini", [ProviderError("declined", refusal=True), picture()])
        pool = EditorPool(primary, ScriptedEditor("fal", []), backoff=())
        result = await pool.edit(picture(), "same prompt", negative="LED")
        assert result.attempts == 2
        assert [call[2]["negative"] for call in primary.calls] == ["LED", None]
        assert all(call[1] == "same prompt" for call in primary.calls)
    asyncio.run(run())


def test_both_rate_limited_reduce_concurrency_and_retry_fallback(monkeypatch):
    configured(monkeypatch, max_concurrency=6)

    async def run():
        primary = ScriptedEditor("gemini", [ProviderError("limited", rate_limited=True)])
        fallback = ScriptedEditor("fal", [ProviderError("limited", rate_limited=True), picture()])
        pool = EditorPool(primary, fallback, backoff=())
        result = await pool.edit(picture(), "test")
        assert pool.max_concurrency == 3
        assert result.attempts == 3 and result.provider == "fal"
        assert len(primary.calls) == 1
    asyncio.run(run())


def test_permanent_errors_do_not_retry_or_leak_exception_details():
    async def run():
        primary = ScriptedEditor("gemini", [ProviderError("missing key", retryable=False)])
        fallback = ScriptedEditor("fal", [ProviderError("missing key", retryable=False)])
        pool = EditorPool(primary, fallback, backoff=())
        with pytest.raises(ProviderError) as error:
            await pool.edit(picture(), "test")
        assert error.value.attempts == 2
        assert len(primary.calls) == len(fallback.calls) == 1
    asyncio.run(run())


def test_pool_enforces_timeout():
    class SlowEditor:
        name = "gemini"
        async def edit(self, *args, **kwargs):
            await asyncio.sleep(10)

    async def run():
        fallback = ScriptedEditor("fal", [picture()])
        pool = EditorPool(SlowEditor(), fallback, max_attempts=1, backoff=())
        result = await pool.edit(picture(), "test", timeout_s=0.01)
        assert result.provider == "fal"
    asyncio.run(run())


def test_pool_uses_each_providers_timeout_when_falling_back():
    async def run():
        primary = ScriptedEditor('openai', [ProviderError('unavailable', retryable=False)])
        primary.default_timeout_s = 180.0
        fallback = ScriptedEditor('gemini', [picture()])
        pool = EditorPool(primary, fallback, backoff=())
        result = await pool.edit(picture(), 'test')
        assert result.provider == 'gemini'
        assert primary.calls[0][2]['timeout_s'] == 180.0
        assert fallback.calls[0][2]['timeout_s'] == 60.0
    asyncio.run(run())


def test_pool_explicit_timeout_overrides_provider_default():
    async def run():
        primary = ScriptedEditor('openai', [picture()])
        primary.default_timeout_s = 180.0
        pool = EditorPool(primary, fallback='', backoff=())
        await pool.edit(picture(), 'test', timeout_s=12.0)
        assert primary.calls[0][2]['timeout_s'] == 12.0
    asyncio.run(run())


def test_demo_is_deterministic_and_explicit(monkeypatch):
    monkeypatch.setenv("DEMO_DELAY_S", "0")

    async def run():
        editor = DemoEditor()
        first = await editor.edit(picture(), "photograph in 1925")
        second = await editor.edit(picture(), "photograph in 1925", seed=5)
        assert first == second and first != picture()
        assert editor.name == "demo"
        pool = EditorPool(editor, ScriptedEditor("fal", []))
        assert pool.fallback is None
    asyncio.run(run())


def test_scene_strict_validation_and_independent_fallback(monkeypatch):
    configured(monkeypatch, provider="gemini", gemini_api_key="test-key")

    async def malformed(_):
        raise ValueError("malformed secret response")

    monkeypatch.setattr(scene, "_request_scene", malformed)
    first = asyncio.run(scene.parse_scene(b"bad image"))
    first["modern_elements"].append("mutated")
    second = asyncio.run(scene.parse_scene(b"bad image"))
    assert second["fallback"] and second["_tokens"] == 0
    assert "mutated" not in second["modern_elements"]
    with pytest.raises(ValueError):
        scene.validate_scene({**scene.DEFAULT_SCENE_SPEC, "sky_fraction": True})
    with pytest.raises(ValueError):
        scene.validate_scene({**scene.DEFAULT_SCENE_SPEC, "extra": "not allowed"})


def test_demo_never_calls_vlm_or_llm_even_with_keys(monkeypatch):
    configured(monkeypatch, provider="demo", gemini_api_key="test", k2_api_key="test")
    calls = []

    async def forbidden(*args):
        calls.append(args)
        raise AssertionError("demo must not call an API")

    monkeypatch.setattr(scene, "_request_scene", forbidden)
    monkeypatch.setattr(constraints, "_request_facts", forbidden)
    scene_result = asyncio.run(scene.parse_scene(picture()))
    spec = asyncio.run(constraints.build_constraints({}, "1920s", scene_result))
    assert calls == [] and spec.fallback and scene_result["fallback"]


def historical_facts():
    return {
        "era_facts": ["period transport", "painted signs", "period lamps", "natural fabrics"],
        "period_summary": "A period of local rebuilding and changing transport.",
        "local_context": ["Use the supplied city and exact year to interpret the scene."],
        "site_state": "unknown",
        "site_history": "The specific site's earlier use has not been verified.",
        "reconstruction_changes": ["Remove buildings known to postdate the target year."],
        "uncertainties": ["No archival evidence for this exact parcel was supplied."],
    }


def test_constraints_are_frozen_and_include_explicit_location_and_year(monkeypatch):
    configured(monkeypatch, provider="demo")
    place = {"name": "Pittsburgh", "cc": "US", "admin1": "Pennsylvania", "lat": 40.443, "lon": -79.94, "prompt_safe": True}
    spec = asyncio.run(constraints.build_constraints(place, "1920s", scene.DEFAULT_SCENE_SPEC))
    assert "1925" in spec.prompt_global and "Pittsburgh" in spec.prompt_global
    assert "Pennsylvania" in spec.prompt_global and "40.443" in spec.prompt_global
    assert spec.target_year == spec.anchor_year == 1925
    assert isinstance(spec.era_facts, tuple)
    with pytest.raises(FrozenInstanceError):
        spec.prompt_global = "changed"
    assert "_tokens" not in spec.to_dict()
    assert constraints.city_country({"name": "5000 Forbes Avenue", "cc": "US", "prompt_safe": False}) == ""
    assert "5000" not in constraints.city_country({"name": "5000 Forbes Avenue", "cc": "US"})


def test_successful_llm_facts_freeze_and_token_usage(monkeypatch):
    configured(monkeypatch, provider="gemini", k2_api_key="test-key", k2_base_url="https://api.ifm.ai/v1", k2_model="IFM/K2-Horizon-375B-A23B")

    async def facts(*args, **kwargs):
        return historical_facts(), 234

    monkeypatch.setattr(constraints, "_request_facts", facts)
    spec = asyncio.run(constraints.build_constraints(
        {"name": "Pittsburgh", "cc": "US", "lat": 40.443, "lon": -79.94, "source": "exif"},
        "1950s", scene.DEFAULT_SCENE_SPEC,
    ))
    assert spec._tokens == 234 and not spec.fallback
    assert "1955" in spec.prompt_global
    assert "period transport" in spec.prompt_global


def test_ifm_k2_request_uses_official_api_contract(monkeypatch):
    configured(monkeypatch, provider="gemini", k2_api_key="test-key", k2_base_url="https://api.ifm.ai/v1", k2_model="IFM/K2-Horizon-375B-A23B")
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"choices": [{"message": {
            "content": json.dumps(historical_facts()),
            "reasoning_content": "private trace must not be used or stored",
        }}], "usage": {"total_tokens": 56}})

    original_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original_client(transport=httpx.MockTransport(respond), **kwargs))
    result = asyncio.run(constraints.build_constraints({}, "1920s", scene.DEFAULT_SCENE_SPEC))
    payload = json.loads(requests[0].content)
    assert str(requests[0].url) == "https://api.ifm.ai/v1/chat/completions"
    assert payload["model"] == "IFM/K2-Horizon-375B-A23B"
    assert payload["chat_template_kwargs"] == {"reasoning_effort": "low"}
    assert "thinking" not in payload
    assert payload["response_format"] == {"type": "json_object"}
    assert result._tokens == 56 and not result.fallback
    assert "private trace" not in result.prompt_global


def test_incomplete_k2_configuration_uses_templates(monkeypatch):
    configured(monkeypatch, provider="gemini", k2_api_key="test-key", k2_base_url="", k2_model="", gemini_api_key="")
    calls = []

    async def forbidden(*args):
        calls.append(args)
        raise AssertionError("Do not send a key to an unspecified provider")

    monkeypatch.setattr(constraints, "_request_facts", forbidden)
    result = asyncio.run(constraints.build_constraints({}, "1920s", scene.DEFAULT_SCENE_SPEC))
    assert calls == [] and result.fallback


def test_queued_primary_requests_reroute_when_circuit_opens(monkeypatch):
    configured(monkeypatch, max_concurrency=1)

    async def run():
        primary = ScriptedEditor("gemini", [ProviderError("unavailable"), ProviderError("unavailable")])
        fallback = ScriptedEditor("fal", [])
        pool = EditorPool(primary, fallback, backoff=())
        results = await asyncio.gather(*(pool.edit(picture(), "one frozen prompt") for _ in range(5)))
        assert len(primary.calls) == 2
        assert len(fallback.calls) == 5
        assert all(result.provider == "fal" for result in results)
        assert sum(result.attempts for result in results) == pool.image_calls == 7
    asyncio.run(run())


def test_refusal_removal_survives_provider_switch():
    async def run():
        primary = ScriptedEditor("gemini", [ProviderError("declined", refusal=True), ProviderError("declined", refusal=True)])
        fallback = ScriptedEditor("fal", [])
        pool = EditorPool(primary, fallback, backoff=())
        result = await pool.edit(picture(), "same prompt", negative="LED signs")
        assert result.provider == "fal"
        assert fallback.calls[0][2]["negative"] is None
        assert fallback.calls[0][1] == "same prompt"
    asyncio.run(run())


def test_explicit_demo_job_never_uses_live_server_keys(monkeypatch):
    configured(monkeypatch, provider="gemini", gemini_api_key="test-key", k2_api_key="test-key")
    calls = []

    async def forbidden(*args):
        calls.append(args)
        raise AssertionError("A demo job must not inherit the live server provider")

    monkeypatch.setattr(scene, "_request_scene", forbidden)
    monkeypatch.setattr(constraints, "_request_facts", forbidden)
    parsed = asyncio.run(scene.parse_scene(picture(), provider="demo"))
    spec = asyncio.run(constraints.build_constraints({}, "1920s", parsed, provider="demo"))
    assert calls == [] and parsed["fallback"] and spec.fallback


def test_rate_limit_recovery_really_runs_at_most_three_calls(monkeypatch):
    configured(monkeypatch, max_concurrency=6)

    class TrackedFallback:
        name = "fal"

        def __init__(self):
            self.first = True
            self.active = self.maximum = 0

        async def edit(self, image, prompt, **kwargs):
            if self.first:
                self.first = False
                raise ProviderError("limited", rate_limited=True)
            self.active += 1
            self.maximum = max(self.maximum, self.active)
            try:
                await asyncio.sleep(0.005)
                return image
            finally:
                self.active -= 1

    async def run():
        primary = ScriptedEditor("gemini", [ProviderError("limited", rate_limited=True)])
        fallback = TrackedFallback()
        pool = EditorPool(primary, fallback, backoff=())
        await pool.edit(picture(), "same prompt")
        results = await asyncio.gather(*(pool.edit(picture(), "same prompt") for _ in range(6)))
        assert len(results) == 6 and fallback.maximum == 3
    asyncio.run(run())

import json
import os

from restaurant import services
from restaurant.picker import Picker

MOCK = os.path.join(services.REPO, "mock-data", "sf_restaurants.json")


def restaurants():
    return json.load(open(MOCK, encoding="utf-8"))["restaurants"]


def run(picker, choices):
    """Answers each step with the next choice (0, 1, 2 or None); returns the steps seen."""
    steps = []
    for c in choices:
        step = picker.next_step()
        if step is None:
            break
        steps.append(step)
        picker.answer(step, c if c is None or c < len(step.options) else 0)
    return steps


def test_mock_data_is_fictional_sf_with_filters():
    rs = restaurants()
    assert len(rs) >= 60 and all(r["city"] == "San Francisco" and "(mock)" in r["address"] for r in rs)
    for attr in ("cuisine", "neighborhood", "price", "diet", "vibe"):
        assert len({r[attr] for r in rs}) >= 3


def test_question_filters_are_applied():
    p = Picker(restaurants())
    heard = p.apply_question("Give me a cheap Italian restaurant in North Beach")
    assert heard == {"cuisine": "Italian", "neighborhood": "North Beach", "price": "$"} or \
        heard.items() <= {"cuisine": "Italian", "neighborhood": "North Beach", "price": "$"}.items()
    assert all(r["cuisine"] == "Italian" for r in p.candidates)


def test_three_options_and_it_always_ends_with_one_restaurant():
    for choices in ([0] * 20, [1] * 20, [2] * 20, [None, 0, None, 1, 2, 0, 0, 0, 0, 0, 0, 0]):
        p = Picker(restaurants())
        steps = run(p, choices)
        assert p.result is not None, choices
        assert all(1 <= len(s.options) <= 3 for s in steps)
        assert all(p.result[a] == v for a, v in p.chosen.items())  # the result honours every choice


def test_none_shows_the_next_three_then_skips():
    p = Picker(restaurants())
    first = p.next_step()
    p.answer(first, None)
    second = p.next_step()
    assert second.attr == first.attr and not set(first.options) & set(second.options)


def test_rerank_puts_the_retriever_order_first():
    rs = restaurants()
    p = Picker(rs)
    p.rerank([rs[-1]["id"], rs[-2]["id"]])
    assert [r["id"] for r in p.restaurants[:2]] == [rs[-1]["id"], rs[-2]["id"]]


def test_local_ranker_prefers_matching_words():
    r = services.LocalRanker()
    rs = restaurants()
    r.index("q", rs)
    top = r.search("q", "vegan thai in the mission")[0]
    doc = next(x for x in rs if x["id"] == top)
    assert sum(w in doc["description"].lower() for w in ("vegan", "thai", "mission")) >= 2


def test_cartesia_requests_use_the_repo_settings():
    c = services.Cartesia("sk_car_test")
    body = c.tts_request("hello")
    assert body["model_id"] == services.SONIC_MODEL and body["voice"] == services.ASSISTANT_VOICE
    assert body["output_format"] == {"container": "wav", "encoding": "pcm_s16le", "sample_rate": 44100}
    assert body["generation_config"] == {"speed": 1.5, "volume": 1}


def test_moss_rows_match_the_web_index_shape():
    row = services.restaurant_rows(restaurants()[:1])[0]
    assert row["source"] == "maps" and set(row) >= {"id", "title", "text", "fetchedAt", "facts"}


def test_env_file_never_overrides_the_environment(tmp_path, monkeypatch):
    f = tmp_path / ".env.local"
    f.write_text("CARTESIA_API_KEY=from_file\nMOSS_PROJECT_ID=\n# comment\n")
    monkeypatch.setenv("CARTESIA_API_KEY", "from_env")
    services.load_env(str(f))
    assert os.environ["CARTESIA_API_KEY"] == "from_env"


def test_everyday_words_become_filters():
    p = Picker(restaurants())
    heard = p.apply_question("I want vegetarian sushi for a date")
    assert heard.get("diet") == "vegetarian friendly" and heard.get("cuisine") == "Japanese"
    assert all(r["diet"] == "vegetarian friendly" and r["cuisine"] == "Japanese" for r in p.candidates)

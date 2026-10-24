"""Writes sf_restaurants.json: fictional San Francisco restaurants for testing the EEG restaurant picker.

Names and addresses are made up; neighbourhoods are real. Deterministic (fixed seed), so the file only
changes when this script does.   python generate_restaurants.py
"""
import json
import os
import random

SEED, COUNT = 13, 80
NEIGHBORHOODS = ["Mission", "North Beach", "Chinatown", "SoMa", "Hayes Valley", "Marina", "Inner Richmond", "Sunset"]
CUISINES = {
    "Italian": ["Trattoria", "Osteria", "Pasta Bar"], "Japanese": ["Izakaya", "Sushi Bar", "Ramen House"],
    "Mexican": ["Taqueria", "Cantina", "Cocina"], "Chinese": ["Dumpling House", "Noodle Bar", "Dim Sum Hall"],
    "Thai": ["Thai Kitchen", "Basil House", "Lemongrass"], "Indian": ["Tandoor", "Curry House", "Masala Room"],
    "American": ["Burger Bar", "Diner", "Grill"], "Vietnamese": ["Pho House", "Banh Mi Shop", "Saigon Kitchen"],
}
FIRST = ["Golden", "Little", "Blue", "Fog City", "Copper", "Wild", "Lucky", "Bay", "Hilltop", "Cable Car", "Mission Street",
         "Pacific", "Sunny", "Old Town", "Night Owl", "Corner"]
VIBES = ["casual", "date night", "family friendly", "quick bite"]
DIETS = ["vegetarian friendly", "vegan options", "gluten free options", "no special diets"]
STREETS = ["Valencia St", "Columbus Ave", "Grant Ave", "Folsom St", "Hayes St", "Chestnut St", "Clement St", "Irving St"]


def main():
    rng = random.Random(SEED)
    out, names = [], set()
    while len(out) < COUNT:
        cuisine = rng.choice(list(CUISINES))
        name = f"{rng.choice(FIRST)} {rng.choice(CUISINES[cuisine])}"
        if name in names:
            continue
        names.add(name)
        hood = rng.choice(NEIGHBORHOODS)
        price = rng.choice([1, 2, 2, 3, 3, 4])
        r = {
            "id": f"sf-{len(out) + 1:03d}",
            "name": name,
            "city": "San Francisco",
            "neighborhood": hood,
            "cuisine": cuisine,
            "price": "$" * price,
            "rating": round(rng.uniform(3.6, 4.9), 1),
            "diet": rng.choice(DIETS),
            "vibe": rng.choice(VIBES),
            "open_late": rng.random() < 0.35,
            "outdoor_seating": rng.random() < 0.4,
            "takes_reservations": price >= 3 or rng.random() < 0.3,
            "address": f"{rng.randint(100, 3999)} {STREETS[NEIGHBORHOODS.index(hood)]}, San Francisco (mock)",
        }
        extras = [x for x, on in (("open late", r["open_late"]), ("outdoor seating", r["outdoor_seating"]),
                                  ("takes reservations", r["takes_reservations"])) if on]
        r["description"] = (f"{name} is a {r['vibe']} {cuisine} restaurant in {hood}, San Francisco. "
                            f"Price {r['price']}, rated {r['rating']}. {r['diet'].capitalize()}."
                            + (f" {', '.join(extras).capitalize()}." if extras else ""))
        out.append(r)
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sf_restaurants.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"note": "FICTIONAL test data: made-up restaurants, real San Francisco neighbourhood names.",
                   "restaurants": out}, f, indent=2)
    print(f"wrote {len(out)} restaurants to {path}")


if __name__ == "__main__":
    main()

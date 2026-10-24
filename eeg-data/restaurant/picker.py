"""Narrows a ranked list of restaurants to one, three choices at a time.

Each step is either a FILTER step (three values of one attribute, e.g. cuisine: Italian / Japanese / Mexican)
or, once three or fewer restaurants are left (or every filter was asked), a PICK step offering restaurants.
"none" (a long clench) moves to the next three choices; past the last one it skips that filter.
The attribute asked next is the one whose top values split the remaining candidates most evenly.
"""
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Optional

FILTERS = [  # (attribute, question read to the wearer)
    ("cuisine", "Food?"),
    ("neighborhood", "Area?"),
    ("price", "Price?"),
    ("diet", "Diet?"),
    ("vibe", "Vibe?"),
]
QUESTION_OF = dict(FILTERS)
SPOKEN_PRICE = {"$": "cheap", "$$": "moderate", "$$$": "pricey", "$$$$": "very expensive"}
SYNONYMS = [  # most specific first; everyday words in a question -> a filter value in the mock data
    ("cuisine", "Mexican", r"\btacos?\b|\bburritos?\b"),
    ("cuisine", "Japanese", r"\bsushi\b|\bramen\b"),
    ("cuisine", "Italian", r"\bpasta\b|\bpizza\b"),
    ("cuisine", "Vietnamese", r"\bpho\b"),
    ("cuisine", "American", r"\bburgers?\b"),
    ("neighborhood", "SoMa", r"\bsoma\b|\bsouth of market\b"),
    ("neighborhood", "Inner Richmond", r"\brichmond\b"),
    ("diet", "vegan options", r"\bvegan\b"),
    ("diet", "vegetarian friendly", r"\bvegetarian\b|\bveggie\b"),
    ("diet", "gluten free options", r"\bgluten[- ]?free\b|\bceliac\b"),
    ("vibe", "date night", r"\bdate\b|\bromantic\b"),
    ("vibe", "family friendly", r"\bfamily\b|\bkids?\b"),
    ("vibe", "quick bite", r"\bquick\b|\bfast\b"),
    ("vibe", "casual", r"\bcasual\b"),
]


SHORT = {"vegetarian friendly": "vegetarian", "vegan options": "vegan", "gluten free options": "gluten free",
         "no special diets": "any diet", "family friendly": "family", "quick bite": "quick", "date night": "date night",
         "Inner Richmond": "Richmond", "Hayes Valley": "Hayes"}


def spoken(attr: str, value: str) -> str:
    """Shortest clear spoken form of a filter value."""
    return SPOKEN_PRICE.get(value, value) if attr == "price" else SHORT.get(value, value)


@dataclass
class Step:
    kind: str                    # "filter" or "pick"
    question: str
    options: List[str]           # up to 3 labels (attribute values, or restaurant ids for "pick")
    attr: Optional[str] = None
    has_more: bool = False       # whether "none" shows three more


@dataclass
class Picker:
    restaurants: List[dict]                          # ranked, best match first
    chosen: Dict[str, str] = field(default_factory=dict)
    done_attrs: set = field(default_factory=set)
    page: Dict[str, int] = field(default_factory=dict)
    result: Optional[dict] = None
    history: List[dict] = field(default_factory=list)

    def __post_init__(self):
        self.restaurants = list(self.restaurants)  # re-ranking must not reorder the caller's list

    @property
    def candidates(self) -> List[dict]:
        return [r for r in self.restaurants if all(r[a] == v for a, v in self.chosen.items())]

    def rerank(self, order: List[str]):
        """New relevance order (restaurant ids) from the retriever; unknown ids keep their place at the end."""
        pos = {rid: i for i, rid in enumerate(order)}
        self.restaurants.sort(key=lambda r: pos.get(r["id"], len(pos)))

    def apply_question(self, text: str) -> Dict[str, str]:
        """Filters the question already names ("italian in north beach") are applied right away."""
        heard = {}
        low = text.lower()
        for attr, _ in FILTERS:
            if attr == "price":
                continue
            for value in sorted({r[attr] for r in self.restaurants}, key=len, reverse=True):
                if re.search(rf"\b{re.escape(value.lower())}\b", low) and \
                        any(r[attr] == value for r in self.candidates):
                    heard[attr] = value
                    break
        for attr, value in heard.items():
            self.chosen[attr] = value
            self.done_attrs.add(attr)
        for attr, value, pattern in SYNONYMS:
            if attr not in heard and re.search(pattern, low) and any(r[attr] == value for r in self.candidates):
                heard[attr] = value
                self.chosen[attr] = value
                self.done_attrs.add(attr)
        if re.search(r"\b(cheap|inexpensive|budget)\b", low) and self._choose_price("$"):
            heard["price"] = "$"
        return heard

    def _choose_price(self, value) -> bool:
        if any(r["price"] == value for r in self.candidates):
            self.chosen["price"] = value
            self.done_attrs.add("price")
            return True
        return False

    def _values(self, attr):
        """Values among the candidates, most common first, ties broken by the best-ranked restaurant."""
        cands = self.candidates
        counts = Counter(r[attr] for r in cands)
        first = {}
        for i, r in enumerate(cands):
            first.setdefault(r[attr], i)
        return sorted(counts, key=lambda v: (-counts[v], first[v]))

    def _split(self, attr) -> float:
        counts = Counter(r[attr] for r in self.candidates)
        if len(counts) < 2:
            return -1.0
        top = [n for _, n in counts.most_common(3)]
        total = sum(top)
        return -sum(n / total * math.log(n / total) for n in top)  # entropy of the three offered values

    def next_step(self) -> Optional[Step]:
        if self.result:
            return None
        cands = self.candidates
        if len(cands) == 1:  # nothing left to choose between
            self.result = cands[0]
            return None
        open_attrs = [a for a, _ in FILTERS if a not in self.done_attrs and self._split(a) > 0]
        if len(cands) > 3 and open_attrs:
            attr = max(open_attrs, key=self._split)
            values = self._values(attr)
            p = self.page.get(attr, 0)
            return Step("filter", QUESTION_OF[attr], values[p * 3:p * 3 + 3], attr, has_more=len(values) > p * 3 + 3)
        p = self.page.get("_pick", 0)
        page = cands[p * 3:p * 3 + 3] or cands[:3]
        return Step("pick", "Pick?", [r["id"] for r in page], has_more=len(cands) > 3)

    def answer(self, step: Step, choice: Optional[int]):
        """choice = 0, 1, 2 for option 1-3, or None for "none of these"."""
        self.history.append({"kind": step.kind, "attr": step.attr, "options": step.options,
                             "choice": None if choice is None else step.options[choice]})
        if step.kind == "pick":
            if choice is None:
                n = len(self.candidates)
                self.page["_pick"] = (self.page.get("_pick", 0) + 1) % max(1, math.ceil(n / 3))
            else:
                self.result = next(r for r in self.candidates if r["id"] == step.options[choice])
            return
        if choice is None:
            if step.has_more:
                self.page[step.attr] = self.page.get(step.attr, 0) + 1
            else:
                self.done_attrs.add(step.attr)  # none of the values: stop asking about this one
            return
        self.chosen[step.attr] = step.options[choice]
        self.done_attrs.add(step.attr)

    def preference_text(self) -> str:
        return ", ".join(spoken(a, v) for a, v in self.chosen.items())

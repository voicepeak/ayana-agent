"""Persistent companion mood, updated from faces the model already chose.

The state is deliberately small: one mood with hysteresis, three slow numeric
dimensions, and a damping log. Every update comes from speech already committed
this turn (resolved_expression / affect / intent), so tracking mood costs no
extra model request. The reply path reads it through prompt(); only committed
faces change it.
"""
from __future__ import annotations

import time
from datetime import datetime

MOODS = ("平静", "愉快", "认真", "低落", "别扭", "生气", "担心", "困倦")

# Faces shown this session are the primary evidence. affect/intent are only a
# fallback for events without a resolved face, never a second vote. Both
# catalogs share the eight moods, so mood tracking works for either character.
FACE_MOOD = {
    "休闲": "平静", "掩饰": "平静", "平静": "平静", "脸红平静": "平静",
    "正经": "认真", "疑惑": "认真", "脸红疑惑": "认真", "吃惊": "认真", "脸红吃惊": "认真",
    "卖萌": "愉快", "脸红卖萌": "愉快", "得意": "愉快", "脸红得意": "愉快",
    "自然微笑": "愉快", "脸红自然微笑": "愉快", "坏笑": "愉快", "病娇惊讶": "愉快",
    "愤怒": "生气",
    "不屑": "别扭", "不同意": "别扭", "脸红不同意": "别扭", "嘟哝": "别扭", "流汗嘟哝": "别扭",
    "闭眼嘟嘴": "别扭", "脸红闭眼嘟嘴": "别扭", "不满": "别扭", "脸红不满": "别扭",
    "无奈": "别扭", "脸红无奈": "别扭",
    "担忧": "担心", "脸红担忧": "担心", "害怕": "担心", "脸红害怕": "担心",
    "失望": "低落", "脸红失望": "低落", "懊悔": "低落", "委屈": "低落", "脸红委屈": "低落",
    "欲哭": "低落", "脸红预哭": "低落", "哭": "低落",
}
AFFECT_MOOD = {"pleased": "愉快", "concerned": "担心", "surprised": "愉快", "neutral": "平静"}
INTENT_MOOD = {"explain": "认真", "encourage": "愉快", "caution": "担心", "playful": "愉快"}

# Per-sentence deltas at intensity 1.0, applied to the three slow dimensions.
CLUSTER_DELTAS = {
    "愉快": {"warmth": 1.2, "patience": 0.7, "energy": 0.2},
    "认真": {"patience": 0.3},
    "担心": {"energy": -0.4, "patience": 0.4},
    "别扭": {"patience": -1.0, "warmth": -0.2},
    "生气": {"patience": -2.0, "warmth": -0.6},
    "低落": {"energy": -0.5, "warmth": -0.1},
}

# Neutral fallbacks and faces whose own descriptions reserve them for explicit
# situations are never pushed as suggestions; they stay freely choosable.
NEVER_SUGGEST = {"休闲", "正经", "平静", "病娇", "背影", "愤怒", "害怕", "脸红害怕",
                 "欲哭", "脸红预哭", "哭"}
SUGGEST_LIMIT = 2

BASELINE = {"energy": 65.0, "patience": 70.0, "warmth": 55.0}
RELAX_RATE = 0.02
DAMPING_WINDOW_SECONDS = 1800
DAMPING_FLOOR = 0.125
TURN_CAP = 3.0
SWITCH_MARGIN = 0.6
STRONG_SWITCH_MARGIN = 1.5
MIN_MOOD_DWELL_SECONDS = 300
SLEEP_GAP_HOURS = 7
NIGHT_START, NIGHT_END = 23, 7
NIGHT_ENERGY = 34.0


def _clamp(value, low, high):
    return max(low, min(high, float(value)))


def local_hour(now):
    return datetime.fromtimestamp(now).astimezone().hour


def suggest_faces(unused, mood):
    """Two unshown, mood-compatible flavors worth trying this reply.

    Guide order is preserved so consuming a suggestion rotates the catalog
    instead of re-randomizing it. Neutral fallbacks and reserved faces are
    never pushed; they stay freely choosable.
    """
    pool = [label for label in unused if label not in NEVER_SUGGEST]
    preferred = [label for label in pool if FACE_MOOD.get(label) == mood]
    return (preferred + [label for label in pool if label not in preferred])[:SUGGEST_LIMIT]


class EmotionState:
    def __init__(self, store):
        self.store = store
        saved = store.get_record("emotion", "state") or {}
        mood = saved.get("mood")
        self.state = {
            "mood": mood if mood in MOODS else "平静",
            "intensity": _clamp(saved.get("intensity", 0.2), 0.0, 1.0),
            "energy": _clamp(saved.get("energy", BASELINE["energy"]), 0, 100),
            "patience": _clamp(saved.get("patience", BASELINE["patience"]), 0, 100),
            "warmth": _clamp(saved.get("warmth", BASELINE["warmth"]), 0, 100),
            "mood_since": saved.get("mood_since", time.time()),
            "updated": saved.get("updated", time.time()),
            "damping": list(saved.get("damping", []))[-24:],
        }

    def settle(self, now=None, hour=None):
        """Apply time-based drift; returns hours since the previous update."""
        now = time.time() if now is None else now
        hour = local_hour(now) if hour is None else hour
        state = self.state
        away = max(0.0, (now - state["updated"]) / 3600)
        if away >= SLEEP_GAP_HOURS:
            state.update(energy=max(state["energy"], 72.0),
                         patience=max(state["patience"], BASELINE["patience"]),
                         mood="平静", intensity=0.15, mood_since=now)
        elif away >= 3:
            state["energy"] = max(30.0, state["energy"] - 1.2 * (away - 3))
            state["patience"] += (BASELINE["patience"] - state["patience"]) * min(1.0, 0.03 * (away - 3))
            state["intensity"] = max(0.1, state["intensity"] - 0.08 * (away - 3))
            if state["intensity"] <= 0.12:
                state["mood"], state["mood_since"] = "平静", now
        if hour >= NIGHT_START or hour < NIGHT_END:
            state["energy"] = min(state["energy"], NIGHT_ENERGY)
            if state["mood"] == "平静":
                state.update(mood="困倦", mood_since=now, intensity=max(state["intensity"], 0.4))
        elif state["mood"] == "困倦" and away >= 1:
            state.update(mood="平静", mood_since=now, intensity=0.15, energy=max(state["energy"], 50.0))
        state["updated"] = now
        self._persist()
        return away

    def apply_turn(self, events, now=None, hour=None):
        """Update mood and dimensions from the faces committed in one reply."""
        now = time.time() if now is None else now
        self.settle(now, hour)
        state = self.state
        votes, deltas = {}, {}
        for event in events:
            mood = self._event_mood(event)
            weight = _clamp(event.get("intensity") or 0.25, 0.1, 1.0)
            votes[mood] = votes.get(mood, 0.0) + weight
            for dimension, value in CLUSTER_DELTAS.get(mood, {}).items():
                deltas[dimension] = deltas.get(dimension, 0.0) + value * weight
        for dimension, base in BASELINE.items():
            state[dimension] = _clamp(state[dimension] + (base - state[dimension]) * RELAX_RATE, 0, 100)
            delta = max(-TURN_CAP, min(TURN_CAP, deltas.get(dimension, 0.0)))
            if delta:
                state[dimension] = _clamp(state[dimension] + self._damped(dimension, delta, now), 0, 100)
        if votes:
            candidate = max(votes, key=votes.get)
            score = votes[candidate]
            current = state["mood"]
            current_score = votes.get(current, 0.0)
            dwell_ok = current == "平静" or now - state["mood_since"] >= MIN_MOOD_DWELL_SECONDS
            if (candidate != current and score >= current_score + SWITCH_MARGIN
                    and (dwell_ok or score >= current_score + STRONG_SWITCH_MARGIN)):
                state.update(mood=candidate, mood_since=now)
                state["intensity"] = _clamp(score / 2, 0.3, 1.0)
            else:
                state["intensity"] = _clamp(max(state["intensity"] * 0.7, score / 2), 0.15, 1.0)
        else:
            state["intensity"] = _clamp(state["intensity"] * 0.8, 0.1, 1.0)
        state["updated"] = now
        self._persist()

    def prompt(self, now=None, hour=None):
        now = time.time() if now is None else now
        away = (now - self.state["updated"]) / 3600
        self.settle(now, hour)
        data = {"mood": self.state["mood"], "intensity": round(self.state["intensity"], 2),
                "energy": round(self.state["energy"]), "patience": round(self.state["patience"]),
                "warmth": round(self.state["warmth"])}
        if away >= 1:
            data["away_hours"] = round(away, 1)
        return data

    @staticmethod
    def _event_mood(event):
        face = event.get("resolved_expression")
        if face in FACE_MOOD:
            return FACE_MOOD[face]
        affect = event.get("affect")
        if affect in AFFECT_MOOD:
            return AFFECT_MOOD[affect]
        return INTENT_MOOD.get(event.get("intent"), "平静")

    def _damped(self, dimension, delta, now):
        direction = 1 if delta > 0 else -1
        recent = [item for item in self.state["damping"] if now - item["at"] <= DAMPING_WINDOW_SECONDS]
        repeats = sum(1 for item in recent if item["dim"] == dimension and item["dir"] == direction)
        recent.append({"at": now, "dim": dimension, "dir": direction})
        self.state["damping"] = recent[-24:]
        return delta * max(DAMPING_FLOOR, 0.5 ** repeats)

    def _persist(self):
        self.store.put_record("emotion", "state", self.state)

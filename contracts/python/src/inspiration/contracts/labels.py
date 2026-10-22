"""Sensitivity label order. Every module compares labels through these helpers."""

from __future__ import annotations

from typing import Final

from .models import SensitivityLabel

SENSITIVITY_ORDER: Final[dict[SensitivityLabel, int]] = {
    SensitivityLabel.public: 0,
    SensitivityLabel.internal: 1,
    SensitivityLabel.confidential: 2,
    SensitivityLabel.secret: 3,
}


def rank(label: SensitivityLabel) -> int:
    return SENSITIVITY_ORDER[label]


def allows(clearance: SensitivityLabel, content: SensitivityLabel) -> bool:
    """True when something cleared for `clearance` may see content labelled `content`."""
    return SENSITIVITY_ORDER[content] <= SENSITIVITY_ORDER[clearance]


def max_label(*labels: SensitivityLabel) -> SensitivityLabel:
    return max(labels, key=lambda label: SENSITIVITY_ORDER[label])

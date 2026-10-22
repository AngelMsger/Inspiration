"""Building and reading event envelopes with typed payloads."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import cast

from pydantic import BaseModel

from .events import PAYLOADS, TYPE_OF_PAYLOAD, VERSIONS, EventType
from .ids import new_id
from .models import EventEnvelope


def new_event[P: BaseModel](
    payload: P,
    *,
    tenant_id: str,
    producer: str,
    subject: str | None = None,
    correlation_id: str | None = None,
    causation: EventEnvelope | None = None,
    occurred_at: datetime | None = None,
) -> EventEnvelope:
    """Wrap a payload model in an envelope. The event type is looked up from the payload class.

    When causation is given, the new event inherits its correlation ID.
    """
    try:
        event_type = TYPE_OF_PAYLOAD[type(payload)]
    except KeyError:
        raise TypeError(f"{type(payload).__name__} is not an event payload") from None
    if causation is not None and correlation_id is None:
        correlation_id = causation.correlation_id or causation.id
    return EventEnvelope(
        id=new_id("event"),
        type=event_type.value,
        version=VERSIONS[event_type],
        tenant_id=tenant_id,
        occurred_at=occurred_at or datetime.now(UTC),
        producer=producer,
        subject=subject,
        correlation_id=correlation_id,
        causation_id=causation.id if causation is not None else None,
        data=payload.model_dump(mode="json", exclude_none=True),
    )


def payload_of[P: BaseModel](event: EventEnvelope, model: type[P] | None = None) -> P:
    """Parse an envelope's data into its payload model.

    Pass the expected model to get a precise type and a check that the event type matches.
    """
    expected = PAYLOADS[EventType(event.type)]
    if model is not None and model is not expected:
        raise TypeError(f"event {event.type} carries {expected.__name__}, not {model.__name__}")
    return cast(P, expected.model_validate(event.data))

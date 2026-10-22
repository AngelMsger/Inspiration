"""Event bus: transactional outbox in Postgres, relay to a transport (Valkey Streams),
consumer groups with retries and dead letters, and an in-memory bus for tests."""

from inspiration.kernel.migrate import MigrationSet

from .consumer import Consumer
from .inbox import first_delivery
from .memory import InMemoryBus, InMemoryTransport
from .outbox import OutboxPublisher, write_outbox
from .relay import OutboxRelay
from .transport import Delivery, Transport
from .valkey import ValkeyStreamsTransport

MIGRATIONS = MigrationSet(component="bus", package="inspiration.eventbus", order=10)

__all__ = [
    "MIGRATIONS",
    "Consumer",
    "Delivery",
    "InMemoryBus",
    "InMemoryTransport",
    "OutboxPublisher",
    "OutboxRelay",
    "Transport",
    "ValkeyStreamsTransport",
    "first_delivery",
    "write_outbox",
]

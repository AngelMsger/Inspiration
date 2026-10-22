# Common tasks. Everything also works without make; see README.md.
SHELL := /bin/bash
COMPOSE := docker compose -f infra/compose.yaml
PY_SRC := contracts/python/src platform/kernel/src platform/eventbus/src modules/m10-store/src \
          modules/m13-authz/src modules/m14-gateway/src

.PHONY: help sync up down reset migrate authz-schema contracts contracts-check lint format typecheck test test-unit check

help:  ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-16s %s\n", $$1, $$2}'

sync:  ## Install Python and TypeScript dependencies
	uv sync
	cd contracts/typescript && npm ci

up:  ## Start Postgres (ParadeDB), Valkey and SpiceDB
	$(COMPOSE) up -d --wait

down:  ## Stop the stack (data is kept)
	$(COMPOSE) down

reset:  ## Stop the stack and delete its data
	$(COMPOSE) down -v

migrate:  ## Apply SQL migrations of every installed package
	uv run inspiration-migrate

authz-schema:  ## Write the SpiceDB schema
	uv run inspiration-authz-schema

contracts:  ## Regenerate Python and TypeScript from contracts/schema
	uv run python contracts/codegen/bundle.py
	uv run python contracts/codegen/gen_python.py
	cd contracts/typescript && node ../codegen/gen_ts.mjs

contracts-check:  ## Fail if generated contracts are stale
	uv run python contracts/codegen/bundle.py --check
	uv run python contracts/codegen/gen_python.py --check
	cd contracts/typescript && node ../codegen/gen_ts.mjs --check && npx tsc --noEmit

lint:  ## Ruff lint and format check
	uv run ruff check .
	uv run ruff format --check .

format:  ## Apply ruff formatting and safe fixes
	uv run ruff check --fix .
	uv run ruff format .

typecheck:  ## mypy (strict)
	uv run mypy $(PY_SRC)

test-unit:  ## Tests that need no stack
	uv run pytest -q -m "not integration"

test:  ## All tests; integration tests fail instead of skipping when the stack is down
	INSPIRATION_REQUIRE_STACK=1 uv run pytest -q

check: lint typecheck contracts-check test  ## Everything CI runs

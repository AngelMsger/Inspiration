# Developer commands. Each target is a thin wrapper, so the pnpm and docker commands work
# without make too (see README.md).

COMPOSE := docker compose -f infra/compose.yaml

.PHONY: install up down clean migrate authz-schema contracts contracts-check lint format typecheck test test-unit check check-full gateway

install:          ## install dependencies, and the parsing worker's Python libraries in .venv
	pnpm install --frozen-lockfile
	python3 -m venv .venv
	.venv/bin/pip install --quiet -r engine/parsing/worker/requirements.txt

up:               ## start Postgres (ParadeDB), Valkey and SpiceDB and wait until healthy
	$(COMPOSE) up -d --wait

down:             ## stop the stack, keeping its data
	$(COMPOSE) down

clean:            ## stop the stack and drop its data
	$(COMPOSE) down -v

migrate:          ## apply the SQL migrations of every installed component
	pnpm exec inspiration-migrate

authz-schema:     ## write the SpiceDB schema
	pnpm exec inspiration-authz-schema

contracts:        ## regenerate the bundled schema, TypeScript types and event catalogue
	pnpm contracts

contracts-check:  ## fail if anything generated from the schemas is stale
	pnpm contracts:check

lint:
	pnpm lint

format:
	pnpm format

typecheck:
	pnpm typecheck

test:             ## all tests; integration tests skip when the stack is down
	pnpm test

test-unit:        ## tests that need no stack
	pnpm test:unit

check: lint typecheck contracts-check  ## everything with the stack required, but the corpus runs that take minutes
	INSPIRATION_REQUIRE_STACK=1 INSPIRATION_QUICK=1 pnpm test

check-full: lint typecheck contracts-check  ## what CI runs: everything, the long corpus runs too
	INSPIRATION_REQUIRE_STACK=1 pnpm test

gateway:          ## serve the model gateway with the fake providers on port 8100
	pnpm exec inspiration-gateway --config config/gateway.dev.yaml

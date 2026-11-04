SHELL := /bin/bash

.PHONY: render up down logs ps backend loadgen docker-up

render:
	bun docker/render.ts

up: render
	cd docker && docker compose up -d

down:
	cd docker && docker compose down -v

ps:
	cd docker && docker compose ps

logs:
	cd docker && docker compose logs -f --tail=100

backend:
	cd apps/backend && bun run src/index.ts

loadgen:
	cd apps/backend && ./scripts/loadgen.sh 250

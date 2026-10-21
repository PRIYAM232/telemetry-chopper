# Telemetry Chopper — top-level developer entrypoints.
# The ocb version MUST match the collector module versions in
# data-plane/builder-config.yaml (both currently v0.156.0).

OCB_VERSION ?= v0.156.0
GOBIN       := $(shell go env GOPATH)/bin
OCB         := $(GOBIN)/builder
# Iterations per benchmark (make bench BENCHTIME=10000x for steadier numbers).
BENCHTIME   ?= 2000x

.PHONY: help ocb tidy build run bench clean

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-10s %s\n", $$1, $$2}'

ocb: ## Install the OpenTelemetry Collector Builder (pinned)
	go install go.opentelemetry.io/collector/cmd/builder@$(OCB_VERSION)

tidy: ## Tidy the custom component modules
	cd data-plane/processors/filterprocessor && go mod tidy
	cd data-plane/extensions/datadogpassthrough && go mod tidy

build: ## Compile the otelcol-chopper binary into data-plane/dist/
	cd data-plane && $(OCB) --config builder-config.yaml

run: ## Run the collector with the local dev pipeline
	./data-plane/dist/otelcol-chopper --config data-plane/config/otelcol-dev.yaml

bench: ## Run the chopper_filter hot-path benchmarks
	cd data-plane/processors/filterprocessor && go test -run '^$$' -bench . -benchmem -benchtime=$(BENCHTIME)

clean: ## Remove ocb build output
	rm -rf data-plane/dist

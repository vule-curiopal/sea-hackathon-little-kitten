# Sea Hackathon Little Kitten

Miu is a Vietnamese–English voice toy for children ages 4–8, featuring a talking kitten with personality, expressive behavior, and shared memories.

## Project structure

```text
backend/
  character/
  memory/
  pipeline/
design/
docs/
  README.md
  product-specification.md
  frontend.md
  pipeline.md
  character-engine.md
  memory-and-time.md
  api-contracts.md
frontend/
```

See the [product specification](docs/product-specification.md) for the product scope and the [implementation workstreams](docs/README.md) for frontend, pipeline, character, PostgreSQL memory/time, and shared API contracts. The handoff includes a no-key fake-provider path and the Mochi Next day demo.

Local `.env` files and their variants are excluded from Git. Keep credentials out of committed files.

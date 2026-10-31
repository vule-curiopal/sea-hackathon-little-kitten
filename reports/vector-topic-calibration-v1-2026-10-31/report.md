Real topic calibration: completed

One actual text-embedding-3-large request, 18 inputs, 1536 dimensions, 358 prompt tokens. Zero dialogue or database requests; runtime policy unchanged.

| Threshold | Positive hit@3 | Unknowns with candidates | Accepted relevant IDs | Accepted unrelated IDs | Precision among all accepted IDs |
| --- | --- | --- | --- | --- | --- |
| 0.35 | 6/8 | 1/4 | 7 | 1 | 0.8750 |
| 0.30 | 8/8 | 1/4 | 10 | 2 | 0.8333 |
| 0.28 | 8/8 | 1/4 | 10 | 3 | 0.7692 |

At 0.28, recall matches 0.30 and one extra unrelated paper-hobby source enters. The unknown cat-breaking-pot query retrieves the reported plant-pot spill at cosine 0.3661 with top-one margin 0.0951; it crosses every tested threshold. A same-species filter cannot resolve that proposition mismatch. These are candidate-level findings; no dialogue false-memory claim was tested here.

Calibration on observed sources and fixed new topics, not held-out acceptance. Four unknown queries cannot establish a safe global threshold. Exact inputs, gold source IDs, complete cosine ranks, margins and request provenance are in [report.json](report.json).

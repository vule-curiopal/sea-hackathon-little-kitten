Real embedding calibration: completed

Exactly 2 actual embedding requests, 19 inputs each, 1536 dimensions; no dialogue or database calls. Threshold stayed at 0.35.

| Model | Projection | Positive hit@3 | Cross-language hit@3 | Cross-language target cosines (VI→EN / EN→VI) | Unknown highest cosine |
| --- | --- | --- | --- | --- | --- |
| text-embedding-3-small | full_json | 4/6 | 0/2 | 0.2006 / 0.1896 | 0.1759 |
| text-embedding-3-small | compact_literal | 4/6 | 0/2 | 0.2516 / 0.1008 | 0.1624 |
| text-embedding-3-large | full_json | 4/6 | 0/2 | 0.3007 / 0.2893 | 0.1494 |
| text-embedding-3-large | compact_literal | 4/6 | 0/2 | 0.3143 / 0.2356 | 0.1453 |

All four configurations accepted no source for the unknown query. Large/full JSON ranked both cross-language targets first, but neither exceeded the unchanged threshold. Compact text improved hobby record coverage without adding a newly answered fact.

This is calibration on six known queries and one unknown, not held-out acceptance. It does not justify lowering a threshold or claiming a production fix. Full rankings, literal inputs, source labels and actual request metadata are in [report.json](report.json).

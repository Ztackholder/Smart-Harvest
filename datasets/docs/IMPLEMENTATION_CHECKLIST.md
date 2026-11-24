# SmartHarvest v3 Revision Checklist

Based on `references/v3_revision_recommendations.md`. This checklist records what is implemented in this delivered dataset/model package and what remains for physical deployment.

## P0: Required

- [x] Normalized yield target and plant density implemented with safe area/count validation and kg conversion at inference.
- [x] Explicit prediction-time feature allowlists and crop category validation.
- [x] Planned target date distinguished from actual harvesting events and outcome dates. Target is weekly mass and can be zero when delayed.
- [x] Simulated missingness scenarios, per-sensor quality metadata, weather-only and manual fallbacks. Stale readings suppressed.
- [x] Fresh chronological train, validation, test with disjoint planting IDs, label availability checks, train-only preprocessing, validation-only model selection, final holdout evaluation.
- [x] Portable generator with CLI output directory, deterministic seed, smoke profile, JSON crop configuration and generated parameter/sensitivity tables.
- [x] Synthetic source provenance stored separately; raw observations and public research are not claimed as actual Seni Tani records.
- [x] Automated integrity checks and reproducibility checks.

## P1: Recommended

- [x] More informative fictional farmer estimate and stronger crop-average yield baseline.
- [x] Compare Random Forest, Ridge and Decision Tree across total-kg and normalized targets.
- [x] Full/air-only/manual routing with scenario breakdown metrics.
- [x] Seven-day raw IoT fixture, deterministic aggregation, duplicate/invalid/stale/partial reading tests.
- [x] Occasional simulated pest/disease, delayed and partial harvest; correlated environmental conditions and measurement discrepancies.
- [x] Fictional unseen-farm holdout diagnostic on the development pool.
- [x] Synthetic weekly shortage-warning precision, recall, false positives and false negatives.
- [ ] Multiple independent crop parameter regimes and multiple fully evaluated simulator seeds. Generator supports these via `--seed` and `--config`; full robustness grid intentionally deferred.
- [ ] Real ESP32 pipeline deployed to the SmartHarvest backend. Fixture and API example are provided, but live hardware integration remains a team engineering task.

## P2: Future physical deployment requirements

- [ ] Collect confirmed historical harvest outcomes from Seni Tani and partner farms.
- [ ] Calibrate each capacitive sensor on its specific soil/probe and collect time-aligned physical readings.
- [ ] Validate synthetic-trained predictions against observed field harvests and recalibrate/retrain.
- [ ] Monitor live model drift and version actual forecast/outcome events.

**Interpretation:** The tested model performance measures agreement with synthetic generator labels, not real-world harvest-prediction accuracy. All physiological coefficients remain uncalibrated. Real data collection and deployment remain outside this revision.

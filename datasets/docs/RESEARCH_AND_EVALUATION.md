# v3 Methodology, Research Provenance and Evaluation

## Relationship to supplied sources

The governing local report is *Laporan Kelompok 09 Deliverable 2 II3120*, Section 3.4.3, which specifies `RandomForestRegressor`, crop, area, crop age and optional environment inputs, per-farm crop-week predictions in kilograms, an independent shortage business rule, and a manual-estimate fallback. The revision recommendations file directs v3 to normalize yields, close leakage risks, strengthen chronology, make source provenance explicit, test sensor fallbacks and provide reproducible scripts.

The original v2 research audit was preserved in `references/source_audit_v2.csv`. Its interpretation is still valid:

- **Mendeley commercial tomato greenhouse** provides evidence that climate and harvested tomato characteristics can be jointly recorded, with crop/system transfer limitations.
- **Zenodo tropical/subtropical agricultural data** are restricted for this usage and cannot directly calibrate plot-week vegetable yields.
- **GitHub 500-row crop-yield CSV** has strong feature-name overlap but covers five non-leafy field crops, weak linear correlations with yield, and uncertain realism. It supplied no crop sensitivity coefficients.
- **HydroGrowNet lettuce** has synchronized hydroponic growth measurements; its soil-water semantics differ from a capacitive soil sensor.
- **Mendeley greenhouse lettuce growth dataset** supports the notion of non-linear growth and environment dependencies, without fitted coefficients in the supplied v2 work.
- **FAO-56 soil-water stress** supports directional stress modeling, but its root-zone water quantities cannot be translated directly into a probe's relative 0–100 wetness index.

All v3 reference yield, temperature optimum, wetness thresholds and stress coefficients are thus clearly identified as **uncalibrated synthetic assumptions** and stored once in `config.json`.

## Changes from v2

1. Original 21-column schema preserved, with documented nullable environment fields and source provenance separated into metadata sidecars.
2. Target definition clarified: kilograms physically harvested **in the planned ISO week**, including zero for a fully delayed harvest. Physical harvest events and outcome dates are separate.
3. First generate latent environment, then produce harvest mass and stress/partial/delay events, then corrupt or remove simulated observed sensor features. This avoids creating labels directly from imputed values.
4. Multiple input availability scenarios: complete IoT, missing soil, simulated weather API, incomplete air readings, manual-only, and offline/stale devices.
5. Mean/max/min environmental summaries retain the 7-day window semantics; source counts represent simulated coverage. Separate actual timestamped fixtures validate `sensor_utils.aggregate`.
6. Normalized yield and plants per square metre are derived in training code; explicit allowlists block identifiers, estimates, actuals and provenance from features.
7. A fresh 3,700/800/752 chronological partition replaces the v2 4,500/752 evaluation for proper validation-only model selection; the 4,500 development pool is preserved for final refit.
8. Portable command-line scripts, seeded generator, JSON crop configuration, independent test reference file, manifest and checksums, and reproducible checks.
9. Added separate weekly demand fixture and shortage warning evaluation. Demand is produced from simulated forecast-time farmer estimates rather than harvest outcome labels.

## Functional simulator assumptions

For a planting, first estimate mass by multiplying reference yield per m² by planted area. Then multiply by crop-specific Gompertz-like age progression, thermal comfort penalty, heat-extreme penalty, VPD penalty, high-RH penalty, dryness/overwetness penalties, minimum-wetness stress, density saturation/competition, fictional site factors and a multiplicative log-normal residual. The `crop_components` function in `generate_dataset.py` defines these hypotheses explicitly. No numerical coefficient is fitted to downloaded agricultural measurements.

Data-quality scenarios are added only after latent harvest mass and events have been generated. Device simulation adds configurable zero-mean sensor noise; simulated weather-grid readings add source-specific measurement discrepancies. Categorical scenario metadata and per-sensor counts remain outside the 21-field model table.

A small probability of pest/disease losses, delayed harvest and partial harvest introduces missing and zero target-week outcomes. These rates are hypothetical and are **not observed incidence rates at Seni Tani**.

## Evaluation discipline

Train+validation is 4,500 rows, test 752. A source planting ID never crosses a split. The maximum physical harvest-event date in training precedes the first validation prediction; the same applies between validation and test. The validation phase compares normalized-vs-total-mass targets and Random Forest, Ridge, and Decision Tree candidate models. Models are then refitted on earlier development records, with the final synthetic test used only for the held-out performance report. No inference field contains the realized outcome.

The selected full-IoT candidate was a **normalized target RandomForestRegressor** based on validation MAE. Three route-specific estimators serve full IoT, air-only, and manual-only inputs. Route metrics are reported separately. The main test is a chronological known-farm scenario; the additional grouped fictional farm test holds four complete farm IDs out of the development pool.

The test MAE of **6.31031 kg**, RMSE **10.07369 kg**, and R² **0.773288** describe the simulator's holdout labels. There are 14 zero target-week labels within 752 test records. The shortage fixture groups distinct test plantings by crop and ISO week, computes predicted/realized aggregate kg, then compares both against independent simulated demand. The resulting **precision 0.8961**, **recall 0.9079**, and **shortage-quantity MAE 19.454 kg** are also synthetic.

The simulated farmer estimate was made more informative than v2 by using crop, planted area, age-based expected growth, fictional farm baseline and partial condition knowledge with added forecast error. Because this still comes from the same simulator, its comparison remains illustrative.

## Remaining limitations and future work

- The simulator is an assumption-driven model and is not calibrated to local plant physiology, crop types, weather, soil type or harvest practices. Its strong internal predictability is not evidence of field accuracy.
- Seven-day input summaries are simulated for the 5,252 main cases; raw timestamped data are generated only for controlled fixture cases.
- Soil readings represent a relative calibrated wetness index. There is no physically defensible universal 43/81 threshold for outdoor gardens.
- Actual farm datasets could have different climate, irrigation, disease, harvest and error distributions. An unseen-farm test using fictional factors cannot demonstrate real transfer.
- The packaged model is an offline scikit-learn artifact, not a live deployed SVC-03 endpoint.
- Real integration must validate crop mapping, authentication, reading provenance, sensor calibrations, weather source semantics, missingness and coordinator review.

**Recommended next empirical step:** collect multiple fully identified planting cycles with calibrated 7-day observations and confirmed before-sort harvest quantities, and evaluate the synthetic-trained predictor directly against those real outcomes before any operational use.

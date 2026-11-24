# SmartHarvest Dataset v3: Review and Revision Recommendations

**Project:** II3120 SmartHarvest, Group 09  
**Reviewed version:** `SmartHarvest_research_informed_dataset_v2.zip`  
**Scope:** Synthetic data generation, model training and evaluation, IoT compatibility, and integration with the harvest prediction service.

## 1. Overall verdict

The v2 dataset is suitable as a foundation for our university prototype. It already includes seven relevant vegetable categories, research-informed nonlinear relationships, a reproducible seed, a chronological train/test split, missing soil moisture values, and explicit documentation of its synthetic origin.

We should retain the existing work and revise it incrementally. The primary objective of v3 is to improve the credibility of our evaluation, align training features with the actual SmartHarvest APIs and ESP32 readings, and make the entire pipeline reproducible by other group members.

All rows and target values remain synthetic. Performance on this dataset measures agreement with the simulator's assumptions. Validation against actual Seni Tani harvest records is a separate future requirement.

### Priority levels

- **P0 (required):** Complete before freezing the dataset and training the final prototype model.
- **P1 (recommended):** Complete if feasible; these improvements strengthen the evaluation and integration.
- **P2 (future):** Valuable extensions that should avoid delaying the core prototype.

## 2. Independent review of v2

The supplied CSV files and generator were reopened and inspected. The following statistics were reproduced from the CSV files.

| Property | Current value |
|---|---:|
| Total records | 5,252 |
| Training records | 4,500 |
| Testing records | 752 |
| Columns | 21 |
| Crop categories | 7 |
| Simulated farms | 32 |
| Simulated plots | 320 |
| Farms shared between training and testing | 32 |
| Plots shared between training and testing | 318 |
| Missing soil moisture records | 295 (5.62%) |
| Missing air temperature or humidity records | 0 |
| Synthetic harvest range | 3.79–135.14 kg |
| Mean synthetic harvest | 38.32 kg |
| Pearson correlation between planted area and harvested quantity | 0.836 |
| Latest training target harvest date | 2025-09-30 |
| Earliest testing prediction date | 2025-10-23 |

### Preliminary model benchmark

The following results were reproduced using the supplied training and testing CSV files. Random Forest configuration: `n_estimators=150`, `min_samples_leaf=2`, `random_state=42`; one-hot encoding for `crop_id`; median imputation fitted on the training set. Each metric is evaluated on the same 752 synthetic test rows in kilograms. The normalized model converts its predictions back to total kilograms before evaluation.

| Model / baseline | MAE (kg) ↓ | RMSE (kg) ↓ | R² ↑ |
|---|---:|---:|---:|
| Global training mean | 17.15 | 20.91 | -0.0001 |
| Synthetic farmer estimate | 11.19 | 15.52 | 0.4490 |
| Training crop-average yield per m² × area | 6.97 | 9.59 | 0.7896 |
| Random Forest: crop + area | 7.78 | 10.87 | 0.7296 |
| Random Forest: without environmental features | 6.35 | 8.60 | 0.8308 |
| Random Forest: all recommended v2 features | 4.83 | 6.68 | 0.8979 |
| Random Forest: normalized yield + plant density | 3.97 | 5.62 | 0.9278 |

The full-feature model achieved approximately 23.8% lower MAE than the sensor-free model on this synthetic test set. The normalized model reduced MAE by approximately 17.8% relative to the original full-feature model.

**Important:** These results are exploratory. We have already inspected the v2 test set to compare modeling choices. For a final v3 benchmark, select models using training/validation data and reserve a fresh, untouched test set. Any improvement in the simulator still requires empirical validation.

## 3. P0: Required changes

### 3.1 Normalize the prediction target and plant population

The current target is `actual_harvest_kg`. Total harvested mass naturally scales with area, and the strong observed correlation with `planted_area_m2` can obscure how well the model learns environmental and crop-growth effects.

**Proposed changes:**

- Preserve `actual_harvest_kg` as the canonical harvest outcome in the database and API.
- Derive a training target: `yield_kg_m2 = actual_harvest_kg / planted_area_m2`.
- Derive `plant_density_per_m2 = plant_count / planted_area_m2`.
- Train a candidate model on normalized yield using plant density in place of raw plant count and area. Keep the original total-kg model as a comparison.
- Convert the predicted yield back to kilograms in the prediction service.
- Reject nonpositive or nonfinite planted areas and invalid plant counts before calculating derived values.
- Evaluate MAE/RMSE in both kg/m² and total kg; use total kg for the coordinator's supply-planning decisions.

```python
# Derived features and target
assert planted_area_m2 > 0
plant_density_per_m2 = plant_count / planted_area_m2
training_target = actual_harvest_kg / planted_area_m2

# Inference
predicted_yield_kg_m2 = model.predict(features)[0]
predicted_harvest_kg = max(0.0, predicted_yield_kg_m2) * planted_area_m2
```

Keep normalization in the model preprocessing/training code or a clearly documented derived dataset. Adding a derived target column to an input CSV can create leakage if features are selected automatically. Use an explicit feature allowlist.

**Acceptance criteria:** Both target formulations are evaluated fairly on the same validation rows, and the final inference API returns total kilograms. The normalized model is selected only if validation supports it.

### 3.2 Freeze an explicit prediction-time feature contract

The methodology lists the following ten v2 inputs. For the normalized model, use the nine inputs below, with `plant_density_per_m2` replacing area and plant count.

```text
crop_id
crop_age_days
days_until_target_harvest
air_temp_mean_7d_c
air_temp_max_7d_c
humidity_mean_7d_pct
soil_moisture_mean_7d_pct
soil_moisture_min_7d_pct
plant_density_per_m2
```

The normalized model has **nine** input fields. The raw `planted_area_m2` and `plant_count` remain required service inputs for deriving density and converting the prediction into kg.

| Field or group | Required handling |
|---|---|
| `crop_id` | Controlled category; use consistent codes across frontend, database, generator, and model. Reject or explicitly handle unsupported crops. |
| `planting_date`, `prediction_at`, `target_harvest_date` | Derive age, horizon, and target week consistently using Asia/Jakarta. Preserve as metadata. |
| `planted_area_m2`, `plant_count` | Validate and derive density. Preserve original units and values. |
| Environmental summaries | Use the same units, aggregation window, calibration semantics, and missing-data policy during training and inference. |
| `estimated_quantity_kg` | Keep as the farmer baseline and coordinator comparison. Consider a separate model using it only as a future experiment. |
| `actual_harvest_kg`, `yield_kg_m2` | Training/evaluation targets only; exclude from inference inputs. |
| Farm, plot, planting IDs | Preserve for joins, grouping, authorization and traceability; exclude from the initial model. |
| `soil_condition` | Derived from soil moisture in v2; keep as display metadata if useful. |
| `valid_sensor_readings_7d` | Use as quality metadata and for fallback selection; exclude from the initial model unless an experiment justifies it. |

Define a data dictionary containing type, units, nullable status, valid ranges, source, and prediction-time availability for all columns. Align it with the group's Deliverable 2 Section 3.4.3 and actual API contract before changing existing fields. The v2 methodology identifies that section as its intended source of truth; the D2 report itself was unavailable in this review.

### 3.3 Resolve the planned-versus-actual harvest date ambiguity

The generator currently computes `harvest_date` from sampled maturity age, then derives the earlier prediction date from the same planned horizon. `target_harvest_date` consequently represents the date used for the simulated outcome. This is internally consistent for an on-schedule simulation, but the schema needs a clear production interpretation.

**Proposed changes:**

- Define `target_harvest_date` as the planned harvest date available at prediction time.
- Derive `days_until_target_harvest` from that date and `prediction_at` only.
- Store `actual_harvest_date` separately as outcome metadata if harvest occurs later or earlier.
- Define whether `actual_harvest_kg` represents the final mass for a planting, or mass harvested during the target CSA week. Keep that definition consistent throughout generation, training and evaluation.
- If predicting a weekly quantity, handle delayed/partial harvests and zero deliveries for that week explicitly. If predicting total cycle yield, use a separate scheduling/allocation step to map it to the weekly CSA supply.
- Preserve the originally issued forecast and its feature snapshot when actual outcomes arrive.

**Acceptance criteria:** Every input field can be obtained at the prediction timestamp. Future harvest dates, actual mass, and future sensor measurements never enter the feature vector.

### 3.4 Improve the missing-data strategy

Currently, soil moisture is missing in 295 rows; temperature and humidity are always available. The `valid_sensor_readings_7d` field is sampled as a count rather than derived from actual timestamped readings. This covers one incomplete-sensor case but leaves other data-source scenarios untested.

Support at least the following scenarios:

| Scenario | Temperature / RH | Soil moisture | Suggested behavior |
|---|---|---|---|
| Complete IoT | Available | Available | Full-feature prediction |
| Partial IoT | Available | Missing | Reduced-feature model or validated imputation |
| Weather API only | Available if supported by provider | Missing | Weather-compatible reduced model, with source and limitations shown |
| Manual farm data | Optional | Optional | Sensor-free fallback if minimum crop information is present |
| Device offline or stale | Stale or unavailable | Stale or unavailable | Exclude stale readings, select fallback, show data-quality warning |
| Insufficient crop data | Any | Any | Request missing required input or return prediction unavailable |

Recommended implementation:

1. Generate a complete latent environmental record and target first.
2. Apply documented observation/missingness scenarios to the inputs while retaining the same target for controlled comparisons.
3. Include missing temperature and humidity, partial sensor failures, and correlated outages across a device/farm. Use configurable scenario proportions; document them as simulation assumptions.
4. Use separate per-sensor counts and freshness/coverage metadata where possible. A single valid count cannot distinguish temperature coverage from soil moisture coverage.
5. Fit any imputer on training data only. Compare median imputation with full-feature and reduced-feature models using validation data.
6. Never fill missing readings with zero. Zero can be a meaningful sensor value and could be interpreted as extreme drought.
7. Preserve the distinction between a direct IoT measurement, a weather API estimate, a manual value, and a simulated value. Weather-station/grid temperatures may differ from plot-level readings; avoid assuming source equivalence without testing.

**Acceptance criteria:** The service handles complete, incomplete, and manual-only data with explicit quality/status information and no unexpected inference errors. Report errors by availability scenario.

### 3.5 Strengthen the evaluation and avoid test-set tuning

Retain chronological evaluation. The v2 split correctly places all training target harvest dates before the earliest test prediction date, and the methodology states that planting IDs are disjoint. However, the same farms and most plots occur in both sets, so the current test represents future predictions on known farms.

**Proposed protocol:**

- Create chronological train, validation, and final test partitions (e.g. roughly 70/15/15, adjusted to full growing cycles and label availability).
- Ensure training labels are available before validation predictions; apply the same rule between validation and test if retraining on both earlier partitions.
- Preserve unique planting groups across splits. If multiple snapshots are generated for one planting, all its snapshots must remain in the same partition.
- Fit all preprocessing, categorical encoding, and imputation within each training fold.
- Select target formulation, model, features, missing-value policy, and hyperparameters using validation only. A small `TimeSeriesSplit` or date-based expanding window is sufficient. Purge training samples whose labels become available after the validation cutoff.
- Freeze the pipeline before evaluating a fresh v3 test set. Keep test labels outside the normal training path.
- Reproduce the v2 benchmark for traceability, but label it exploratory.

**Acceptance criteria:** The evaluation script can reproduce all splits, verifies label availability and planting disjointness, and reports final holdout metrics after model selection has been frozen.

### 3.6 Make the dataset generator portable and reproducible

The supplied generator hardcodes `OUT = Path("/mnt/data")` and executes generation and writes at module import. It writes the four core data CSVs, while the source audit, parameter CSV, sensitivity CSV, and methodology are packaged separately. These are concrete reproducibility gaps.

**Proposed changes:**

- Add command-line options for output directory, seed, and configurable dataset size or generation profile.
- Put generation inside `main()` with an `if __name__ == "__main__":` guard. Importing model/generator utilities should have no file-writing side effects.
- Initialize the seeded RNG inside the generation function, so repeated calls with the same seed reproduce the same data.
- Use a versioned configuration file or parameter table as the single source of truth for crop coefficients and scenario settings. Avoid independently maintaining duplicate parameter values in Python and CSV.
- Generate the sensitivity analysis from the same yield function used for dataset generation. Document exact reference inputs and perturbations.
- Treat the source audit and methodology as maintained research documents. Include a manifest identifying which files are generated and which are manually maintained.
- Provide `requirements.txt` or a pinned environment file for training/evaluation dependencies and a short README with commands to regenerate and evaluate.
- Add version/seed, configuration hash, file hashes, row counts, and split dates to a dataset manifest.

Example intended usage (to implement):

```bash
python generate_dataset.py --output-dir data/v3 --seed 20261124
python train.py --data-dir data/v3 --output-dir artifacts/v3
python evaluate.py --data-dir data/v3 --model-dir artifacts/v3
```

**Acceptance criteria:** Another teammate can run the documented commands on their own computer, reproduce the dataset with the same configuration, and train/evaluate the model without editing absolute paths.

### 3.7 Add explicit synthetic provenance and reporting safeguards

The methodology already states that the dataset is 100% synthetic and explains the limitations of each source. Preserve this strength.

- Keep `data_origin`, sensor source, and scenario labels in a separate metadata manifest/table or extend the schema with team approval. The v2 main CSV deliberately excludes these columns; avoid breaking D2 compatibility unnecessarily.
- Exclude provenance/scenario metadata from the model unless its use is separately justified and evaluated.
- In the database and demo UI, distinguish real ESP32 observations from synthetic seed readings, simulated harvest labels, and actual future farmer records.
- Record model version, dataset version, training date, and prediction generation timestamp.
- Describe the coefficients as uncalibrated assumptions, even when inspired by research. The supplied source audit documents metadata-only or restricted access for several public datasets; do not claim those raw data were used to fit parameters.
- Report metrics as synthetic benchmark results. For example: “Random Forest achieved 3.97 kg MAE on the v2 simulated test set.” Avoid describing R² as percentage accuracy.

**Acceptance criteria:** The dataset, model report and frontend clearly communicate the synthetic origin and the limits of real-world validity.

## 4. P1: Recommended improvements

### 4.1 Improve the simulated farmer baseline and compare multiple models

The v2 farmer estimate is approximately crop-reference yield × area × random factor. It omits many conditions that determine the simulated outcome, which structurally favors the sensor-aware model.

- Keep the original baseline for backward comparison.
- Include training-only crop-average yield per m² × area as a simple, stronger baseline.
- Add a more informative simulated farmer estimate using planting age, density, typical farm productivity or coarse observations available to the farmer, with documented estimation noise and bias. Do not derive it directly from the final outcome or future measurements.
- Compare Linear/Ridge Regression (with suitable encoding), a single Decision Tree, Random Forest, and optionally a gradient-boosted tree model. Use the same validation splits and features for a fair comparison.
- Record MAE, RMSE, R², mean signed error (bias), and runtime. Break down errors by crop, harvest size, forecast horizon, and input availability.
- Report MAE/RMSE in kg/m² alongside kg. If percentage errors are used, handle zero or very small yields explicitly.
- Include ablation experiments: crop/area baseline, sensor-free model, air-only model, full sensor model, and normalized-yield model.

Random Forest remains a sensible default. Select the final model based on validation performance, inference simplicity, and robustness. A more complex model is optional.

### 4.2 Make sensor aggregation compatible with ESP32 deployment

The model expects seven-day summaries, whereas the ESP32 produces instantaneous readings. The v2 generator samples summary statistics directly; there are currently no raw seven-day time-series files in the ZIP.

Agree on a consistent contract with the backend/IoT team:

| Feature | Computation from observations available before prediction |
|---|---|
| `air_temp_mean_7d_c` | Mean valid air temperature during the preceding seven days |
| `air_temp_max_7d_c` | Maximum valid observed air temperature over the same window |
| `humidity_mean_7d_pct` | Mean valid relative humidity |
| `soil_moisture_mean_7d_pct` | Mean calibrated relative wetness index |
| `soil_moisture_min_7d_pct` | Minimum calibrated relative wetness index |

- Define the window precisely, e.g. `[prediction_at - 7 days, prediction_at)`, with timezone-aware timestamps.
- At the proposed 15-minute sampling cadence, a complete seven-day window contains 672 expected observation slots per device. Use that cadence consistently in the generator and backend, or adjust the expected count for the actual configured interval.
- Deduplicate readings and exclude invalid or future measurements. Use a defined slot-based or time-weighted aggregation rule if sampling intervals vary significantly.
- Document minimum coverage and staleness thresholds. An initial 80% coverage threshold can be tested as an engineering assumption; it requires no claim of agronomic validity. Route insufficient windows to the fallback policy.
- Calibrate each capacitive probe with documented dry/wet reference readings. The dataset's 0–100 soil index is relative wetness, with higher values indicating wetter soil. It represents a calibrated relative index rather than volumetric water content. Avoid presenting it as a universal crop-specific moisture percentage.
- Confirm that SHT31/BME280 temperature and RH units match the training contract; atmospheric pressure has no current role in the model.
- Add tests that reproduce known aggregate values from raw samples, including a missing interval, duplicate timestamp, invalid value, stale window and future observation.

For the demo, create a small raw sensor fixture for one or more plots that produces verifiable aggregates through the actual backend. A full raw time series for every synthetic row is unnecessary for the MVP. Seed seven days of clearly labeled synthetic readings and append live ESP32 readings; keep simulated and measured provenance visible.

### 4.3 Improve realism and test robustness to simulator assumptions

The existing generator uses Gompertz-like growth, temperature and heat penalties, VPD, soil wetness stress, plant density, farm/plot factors and lognormal noise. Retain these mechanisms, while acknowledging that their numeric coefficients remain hypothetical.

Potential revisions:

- Distinguish the seven-day climate window from the complete growing cycle. Introduce simplified prior/future growing-condition variability or separate stress scenarios to avoid assuming the last seven days fully determine harvest.
- Calculate season context from the environmental observation window rather than solely from `planting_date`; a planting can cross a season boundary.
- Simulate occasional disease, pest damage, harvest failure, partial harvest or delayed harvest where consistent with the chosen target definition. Currently all outputs are positive, with a minimum of 3.79 kg. Use documented, configurable scenario rates and avoid inventing observed Seni Tani frequencies.
- Add small, plausible observation noise and device-specific calibration error to sensor readings, separate from latent conditions used to calculate the synthetic label. Keep the error magnitudes configurable and clearly hypothetical unless sourced.
- Test several simulator seeds, noise levels, crop parameter variants and environmental shifts. Report how much model error changes when the assumptions change.
- Maintain physical checks: maximum temperature ≥ mean temperature, minimum wetness ≤ mean wetness, RH and wetness within the defined scale, and positive plot area.
- Verify the crop mapping with the team; clarify whether `SPINACH` denotes true spinach or a locally used bayam category distinct from `AMARANTH`. Keep categories consistent with the crops actually represented in the prototype.

Avoid adding extra agricultural variables to the inference schema unless the corresponding data can realistically be collected at prediction time. Additional latent disturbances are useful for stress testing even when they cannot be directly observed by the model.

### 4.4 Evaluate generalization to new farms

All 32 simulated farms appear in both v2 splits. Retain the known-farm temporal benchmark and add a separate grouped test if feasible.

- Hold out several entire farms (or use grouped cross-validation by `farm_id`), including their plots and planting cycles.
- Where possible combine farm holdout with a time cutoff to emulate a newly onboarded farmer.
- Fit preprocessing using only the training farms; exclude identifiers from the feature vector.
- Report grouped-test results separately from the known-farm chronological test.

This experiment measures robustness to fictional site differences. Real transfer to an unseen Seni Tani farm still requires field observations.

### 4.5 Evaluate the actual business decision: shortage risk

SmartHarvest's business objective is sufficient weekly CSA supply. A low yield MAE alone provides limited evidence about shortage-warning quality.

- Define weekly demand by crop and target period in a separate demand/allocation fixture. Demand belongs to the business service; it is unnecessary as a yield-model feature.
- Aggregate predictions across eligible, distinct plantings for the same crop and target week, avoiding double counting repeated forecasts for a planting.
- Compute predicted shortage as `max(0, weekly_demand_kg - predicted_supply_kg)`.
- Compare predicted shortage with the realized shortage derived from synthetic actual supply and the same demand.
- Report shortage precision, recall, false negatives, and shortage quantity MAE. Show separate results per crop when sample counts permit.
- Consider a conservative warning based on validation residuals or empirically calibrated prediction intervals. Quantiles across Random Forest trees alone do not establish calibrated confidence intervals.
- Keep coordinator review and approval in the workflow. Clearly communicate insufficient/stale input and simulated model status.

## 5. P2: Future work

- Collect and verify historical records from Seni Tani and its farmer partners: crop identity, planting/harvest dates, plot area, plant count, planned quantities, actual quantities, and available environmental history.
- Gather real time-aligned ESP32 observations and actual harvest outcomes. Calibrate wetness measurements for the soil/probe used at each site.
- Evaluate the synthetic-trained model against real observations before using it for operational CSA decisions. Retrain or recalibrate on representative real data as it becomes available.
- Investigate full-cycle environmental summaries, weather forecasts, irrigation records, and measured crop-growth indicators only when the data collection process supports them.
- Monitor prediction drift and error over time. Record forecast versions and actual outcomes so later retraining can be evaluated reproducibly.

## 6. Proposed validation checklist

Add automated checks for the following before publishing v3:

- [ ] Required columns, data types, units and crop IDs match the agreed service contract.
- [ ] Generated row counts match the configuration; each planting/snapshot identity is unique where expected.
- [ ] No duplicated records, orphaned outcome records, or inconsistent input/ground-truth joins.
- [ ] Plot-to-farm and planting-to-plot mappings remain consistent.
- [ ] Planting dates, planned dates, forecast timestamps and target weeks are logically consistent.
- [ ] Actual label availability precedes the next evaluation partition's prediction cutoff.
- [ ] Planting groups are disjoint across partitions, and farm groups are disjoint in the optional unseen-farm test.
- [ ] All numeric values are finite where required; area is positive, count is valid, and harvest is nonnegative.
- [ ] Soil mean/minimum, temperature mean/maximum, humidity and quality counts satisfy documented bounds.
- [ ] Missing environmental values and source scenarios match the declared configuration.
- [ ] Derived normalized targets and plant density are correct and excluded from inappropriate input paths.
- [ ] Inference feature allowlist contains only information available at prediction time.
- [ ] Test input files exclude targets, and reference labels join by stable identifiers.
- [ ] All preprocessing is fitted only on the allowed training partition.
- [ ] Identical configuration and seed reproduce the same generated data; different seeds produce distinct draws.
- [ ] Raw sensor fixtures produce the expected seven-day summaries and fallback behavior.
- [ ] Predictions returned by the service are finite, nonnegative, versioned and expressed in kg.
- [ ] Model metrics, sensitivity analyses, data-origin labels and research limitations are documented accurately.

## 7. Expected deliverables for the next revision

The exact filenames can follow the existing naming convention. Preserve the original v2 ZIP for comparison.

| Deliverable | Expected contents |
|---|---|
| Dataset generator + configuration | Portable, deterministic generation; crop parameters and missingness/stress scenarios |
| Train/validation/test CSVs | Versioned, chronological partitions; final test kept separate |
| Test input and label files | Feature-only inputs and independently joinable synthetic outcomes |
| Data dictionary and schema | Types, units, bounds, nullability, availability, feature/target roles |
| Provenance and dataset manifest | Synthetic status, seed, source audit, file hashes, split definitions |
| Sensitivity analysis | Reproducible scenarios generated from the same yield function |
| Training and evaluation scripts | Baselines, normalized/raw target comparisons, preprocessing and metrics |
| Model artifacts | Serialized preprocessing + estimator, feature allowlist, metadata and version |
| Small sensor fixture and aggregation tests | Timestamped readings, expected aggregates, failure scenarios |
| Methodology and results report | Assumptions, validation protocol, benchmark results and limitations |
| README | Steps to regenerate, train, evaluate, and connect to the prediction service |

## 8. Implementation order and scope freeze

1. Agree on target semantics and the D2-compatible feature contract with the backend team.
2. Refactor the generator, define missingness scenarios, add data validation, and create fresh chronological partitions.
3. Implement the normalized-target experiment, baseline comparisons, and fallback models.
4. Select the model on validation data, then run the final holdout evaluation and export the model pipeline.
5. Connect the seven-day aggregation fixture and live ESP32 ingestion to the prediction API.
6. Demonstrate the coordinator workflow: predict, compare with demand, review shortages, approve allocation, record outcomes, and evaluate forecasts.
7. Complete optional robustness experiments and document all remaining limitations.

**Scope freeze:** v3 can remain entirely synthetic for the assignment. Prioritize a reproducible and transparent end-to-end pipeline. Additional sensors, complex agronomic simulators, large neural networks and extensive hyperparameter searches can remain outside the MVP.

### Final recommendation

Proceed with the v2 foundation and focus the revision on normalized yield, prediction-time feature semantics, missing-data support, fresh holdout evaluation, and reproducibility. Retain the existing research-informed generation and source audit. This will provide a defensible prototype for IoT, AI and SOA integration, while preserving a clear path toward later empirical calibration with Seni Tani.

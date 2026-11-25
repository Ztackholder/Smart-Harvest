# SmartHarvest Harvest Prediction (SVC-03)

This Python module predicts a planned harvest quantity in kilograms for one crop planting. The backend imports `HarvestPredictor` directly. It does not start a REST service, write to a database, assign prediction IDs, or assess supply shortages.

## Dataset and target

Training uses the read-only SmartHarvest synthetic dataset v3 in `datasets/data/v3/`. The training command checks each file against `manifest.json`, validates partition and feature contracts, and preserves the supplied train, validation, training-pool, and test inputs. The test ground truth is read only after validation-based selection, final refit, and serialization.

The model learns `yield_kg_m2 = actual_harvest_kg / planted_area_m2`. Inference converts the predicted yield to total quantity using the requested area. Zero-harvest records and nullable sensor values are retained. `plant_density_per_m2 = plant_count / planted_area_m2` is calculated at training and inference time.

All records and labels in v3 are synthetic. The dataset is not field validated, and its reported metrics do not establish accuracy for Seni Tani or any real farm.

## Features and model

Each model is a scikit-learn `Pipeline` with a `ColumnTransformer`: crop codes use one-hot encoding, numeric columns use a median imputer fitted only on the corresponding training rows, and the estimator is a `RandomForestRegressor`. Explicit route allowlists exclude IDs, farmer estimates, actual outcomes, the normalized target, provenance, scenario, and quality metadata from regression features.

| Inference route | Features |
| --- | --- |
| `full` | Crop, age, days to target, air summaries, soil summaries, plant density |
| `air` | Crop, age, days to target, air summaries, plant density |
| `manual` | Crop, age, days to target, plant density |

Air IoT observations need valid readings, at least 80% coverage for temperature and humidity, and freshness within 24 hours. Soil IoT observations need valid readings, at least 80% coverage, and freshness within 24 hours. A valid explicit weather API source can provide the air route without IoT slot counts. Missing or stale quality metadata cannot promote sensor values to a sensor route. Invalid optional readings fall back to a lower route; the `manual` route is still an AI prediction. It is distinct from the business fallback `MANUAL_ESTIMATE`.

The supported crop codes are `AMARANTH`, `KANGKUNG`, `LETTUCE`, `PAKCHOY`, `MUSTARD_GREENS`, `SPINACH`, and `KALE`. `AMARANTH` and `SPINACH` are separate categories.

## Setup and training

Run commands from the repository root with Python 3.11 or newer:

```powershell
python -m pip install -r ai/requirements.txt
python -m ai.src.train --data-dir datasets/data/v3 --output-dir ai/models --seed 42
```

Training compares global mean, farmer estimate, crop-average yield, Ridge Regression, Decision Tree, and Random Forest candidates. The Random Forest search evaluates 16 seeded configurations on the validation full-sensor route, ranks them primarily by total-kg MAE, then refits the selected settings on the 4,500-row training pool. It fits the full route on rows with valid full sensor data, the air route on rows with valid air data, and the manual route on all pool rows.

The command prints validation and holdout metrics and writes only `ai/models/model.joblib`. It does not save reports, logs, predictions, charts, or notebooks. The generated artifact contains all three fitted pipelines, feature allowlists, routing thresholds, selected parameters, runtime versions, and synthetic dataset provenance. Joblib artifacts can execute code when loaded; only load an artifact produced by a trusted training run.

## Backend inference

```python
from ai.src.predict import HarvestPredictor

predictor = HarvestPredictor("ai/models/model.joblib")
result = predictor.predict(
    {
        "crop_id": "LETTUCE",
        "planting_date": "2026-10-01",
        "prediction_at": "2026-11-20T09:00:00+07:00",
        "target_harvest_date": "2026-11-25",
        "planted_area_m2": 8.0,
        "plant_count": 64,
        # Optional seven-day sensor summaries:
        "air_temp_mean_7d_c": 23.5,
        "air_temp_max_7d_c": 29.0,
        "humidity_mean_7d_pct": 74.0,
        "soil_moisture_mean_7d_pct": 58.0,
        "soil_moisture_min_7d_pct": 44.0,
        # Optional v3-style sensor quality metadata:
        "sensor_quality": {
            "air_source": "simulated_iot",
            "soil_source": "simulated_iot",
            "temperature_valid_slots": 620,
            "humidity_valid_slots": 615,
            "soil_valid_slots": 610,
            "expected_window_slots": 672,
            "air_last_seen_hours": 4.0,
            "soil_last_seen_hours": 5.0,
            "status": "SIMULATED",
        },
    }
)
```

The predictor loads the artifact once during initialization. It derives crop age and target horizon in `Asia/Jakarta`, validates mandatory dates and planting values, selects `full`, `air`, or `manual`, and returns finite non-negative kilograms. Successful output includes `status: "PREDICTED"`, `predicted_quantity_kg`, `model_version`, `inference_route`, and `training_provenance`. Invalid mandatory inputs, unsupported crops, or inference failures return `status: "PREDICTION_UNAVAILABLE"` with a structured error code. For a sensor-free AI prediction, omit the optional sensor fields and quality metadata.

The backend remains responsible for HTTP handling, authentication, persistence, IDs, sensor aggregation, and business decisions. It should handle `PREDICTION_UNAVAILABLE` and keep coordinator shortage assessment in SVC-04.

## Verified evaluation

The selected validation result was `n_estimators=320`, `max_features=1.0`, `min_samples_leaf=2`, and `max_depth=None`. On the 492 validation rows routed to `full`, it scored MAE **5.5828 kg**, RMSE **9.0413 kg**, R² **0.8036**, and prediction bias **−0.4257 kg**. Ridge scored 6.3150 kg MAE and Decision Tree 9.4051 kg MAE on the same rows. On all 800 validation rows, MAE was 16.8974 kg for the constant mean-kg baseline, 9.6795 kg for global mean yield, 11.2626 kg for the farmer estimate, and 8.5414 kg for crop-average yield.

The frozen serialized predictor produced the following test metrics from actual predictions on the supplied 752-row v3 benchmark holdout:

| Scope | Rows | MAE (kg) | RMSE (kg) | R² | Bias (kg) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Overall | 752 | 6.3292 | 10.0797 | 0.7730 | −0.8429 |
| `full` route | 457 | 5.5233 | 9.3865 | 0.7895 | −0.3075 |
| `air` route | 124 | 6.9789 | 10.4912 | 0.7930 | −0.7559 |
| `manual` route | 171 | 8.0117 | 11.4684 | 0.7140 | −2.3368 |

The supplied v3 benchmark reports overall MAE 6.3103 kg, RMSE 10.0737 kg, R² 0.7733, and bias −0.8074 kg. The small differences above are from this locally trained configuration. This holdout is a reproducibility benchmark already evaluated in the v3 release, not an untouched independent test. Of its 14 zero-harvest records, the model's MAE was 39.3217 kg; the regressor has no separate zero-event classifier.

## Limitations

- Dataset features, yields, sensor readings, and crop coefficients are simulated; physiological assumptions are uncalibrated.
- The test holdout is synthetic and has been used as a benchmark before this implementation.
- Missing and delayed harvests can be difficult for a continuous regression model; zero-harvest predictions are especially weak.
- The backend and hardware must agree on crop-code mapping, the `Asia/Jakarta` date convention, seven-day summary semantics, and quality metadata.
- Real deployment requires field data collection, sensor calibration, and evaluation against confirmed harvests before operational use.

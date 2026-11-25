"""scikit-learn preprocessing and estimator pipelines."""

from __future__ import annotations

from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

from .features import FEATURE_ALLOWLISTS


def make_preprocessor(route: str) -> ColumnTransformer:
    """Create route-specific, train-fitted categorical and numeric transforms."""
    if route not in FEATURE_ALLOWLISTS:
        raise ValueError(f"Unknown prediction route: {route}")
    features = FEATURE_ALLOWLISTS[route]
    categorical = ["crop_id"]
    numeric = [name for name in features if name not in categorical]
    numeric_pipeline = Pipeline(
        steps=[
            (
                "imputer",
                SimpleImputer(strategy="median", keep_empty_features=True),
            )
        ]
    )
    return ColumnTransformer(
        transformers=[
            ("crop", OneHotEncoder(handle_unknown="ignore"), categorical),
            ("numeric", numeric_pipeline, numeric),
        ],
        remainder="drop",
    )


def make_pipeline(route: str, estimator) -> Pipeline:
    """Wrap a model with the feature contract and learned preprocessing."""
    return Pipeline(
        steps=[
            ("preprocessor", make_preprocessor(route)),
            ("regressor", estimator),
        ]
    )
